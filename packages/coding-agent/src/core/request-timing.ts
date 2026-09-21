/**
 * Per-request phase timing for provider requests.
 *
 * Answers "what is the agent waiting for" when the TUI sits in `Waiting`
 * before the first reasoning/text token appears: the wait is split into
 * client-side phases (turn dispatch -> prompt-built -> request-sent) and
 * wire/server phases (request-sent -> first-byte covers request body
 * serialization, upload, and provider TTFB). A long request-sent ->
 * first-byte gap with a normal server-side TTFT points at slow upload or
 * provider prefill/prompt-cache miss rather than client work, and the
 * stream-done summary carries the final usage so a cache miss shows as
 * cacheRead ~ 0 with cacheWrite ~ the full prompt.
 *
 * Enable with `PI_REQUEST_TIMING=1` (env, inherited by daemon workers) or
 * `"requestTiming": true` in settings.json. Entries go to the shared JSONL
 * diagnostic log (~/.prime/agent/logs/agent.jsonl) under the component
 * "coding-agent.request-timing".
 *
 * Zero overhead when disabled: the wrappers pass straight through with no
 * timestamps, no payload serialization, and no log entries.
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessageEventStream, getLogger, type Message } from "@earendil-works/pi-ai";

const log = getLogger("coding-agent.request-timing");

const REQUEST_TIMING_ENV = "PI_REQUEST_TIMING";

/** Whether request timing is on. Evaluated per request so the flag can change without a restart. */
type RequestTimingEnabled = () => boolean;

/** Truthy follows the PI_OFFLINE/PI_TIMING convention: 1/true/yes. */
function truthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Request timing is on when either the settings flag or the env override is
 * set. Both checks are cheap property reads on the disabled path.
 */
export function isRequestTimingEnabled(settingsFlag: boolean): boolean {
	return settingsFlag || truthyEnvFlag(process.env[REQUEST_TIMING_ENV]);
}

/** Correlation state recorded while the agent loop builds the request. */
interface PromptBuildTiming {
	/** Turn dispatch: streamAssistantResponse entry (first seam of the turn). */
	dispatchedAt: number;
	/** After convertToLlm: the LLM message array is built. */
	promptBuiltAt: number;
	/** LLM message count of the built prompt. */
	contextEntries: number;
}

/** Dispatch timestamps keyed by the transformContext result array. */
const dispatchedAtByContext = new WeakMap<object, number>();
/** Built-prompt timing keyed by the convertToLlm output array (fresh per turn). */
const promptBuildByLlmMessages = new WeakMap<object, PromptBuildTiming>();
/** Per-request sequence numbers keyed by the LLM messages array. */
const requestSeqByLlmMessages = new WeakMap<object, number>();
let moduleRequestSeq = 0;

/**
 * Record the turn dispatch time for the array that continues into prompt
 * build. The agent context snapshot array is reused across turns of one
 * run, so the latest turn overwrites the previous entry; concurrent agents
 * use distinct arrays and cannot collide.
 */
function markRequestTimingDispatch(messages: object[], dispatchedAt: number): void {
	dispatchedAtByContext.set(messages, dispatchedAt);
}

function takeRequestTimingDispatch(messages: object[]): number | undefined {
	return dispatchedAtByContext.get(messages);
}

/**
 * Instruments the agent-loop transformContext seam: the entry timestamp is
 * the request's "send-received" moment (turn dispatch).
 */
export function instrumentTransformContext(
	enabled: RequestTimingEnabled,
	transform: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	return async (messages: AgentMessage[], signal?: AbortSignal) => {
		if (!enabled()) {
			return transform(messages, signal);
		}
		const startedAt = performance.now();
		const result = await transform(messages, signal);
		markRequestTimingDispatch(result, startedAt);
		return result;
	};
}

/**
 * Instruments the agent-loop convertToLlm seam: records the prompt-built
 * phase (with the LLM message count) keyed by the output array the provider
 * request consumes, and emits the prompt-built phase entry.
 */
export function instrumentConvertToLlm(
	enabled: RequestTimingEnabled,
	convert: (messages: AgentMessage[]) => Message[],
): (messages: AgentMessage[]) => Message[] {
	return (messages: AgentMessage[]) => {
		if (!enabled()) {
			return convert(messages);
		}
		const output = convert(messages);
		const startedAt = takeRequestTimingDispatch(messages) ?? performance.now();
		const built = performance.now();
		const timing: PromptBuildTiming = {
			dispatchedAt: startedAt,
			promptBuiltAt: built,
			contextEntries: output.length,
		};
		promptBuildByLlmMessages.set(output, timing);
		log.info("request timing", {
			phase: "prompt-built",
			requestSeq: nextRequestSeq(output),
			phaseMs: roundMs(built - startedAt),
			totalMs: roundMs(built - startedAt),
			contextEntries: output.length,
		});
		return output;
	};
}

function nextRequestSeq(llmMessages: object): number {
	let seq = requestSeqByLlmMessages.get(llmMessages);
	if (seq === undefined) {
		seq = ++moduleRequestSeq;
		requestSeqByLlmMessages.set(llmMessages, seq);
	}
	return seq;
}

/** Provider request identity fields shared by every phase entry. */
interface RequestTimingRequestInfo {
	model: string;
	provider?: string;
	api?: string;
	sessionId?: string;
}

/**
 * Mutable phase clock for one provider request. Created at the streamFn
 * seam; phase transitions are logged as they happen so a hung request shows
 * the last completed phase in the live log.
 */
class RequestTiming {
	readonly requestSeq: number;
	private readonly info: RequestTimingRequestInfo;
	private readonly dispatchedAt: number | undefined;
	private readonly promptBuiltAt: number | undefined;
	private readonly contextEntries: number | undefined;
	private readonly streamFnEnteredAt: number;
	private requestSentAt: number | undefined;
	private requestBytes: number | undefined;
	private firstByteAt: number | undefined;
	private firstTokenAt: number | undefined;
	private streamDoneAt: number | undefined;
	private stopReason: string | undefined;
	private errorMessage: string | undefined;
	private usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
	private summaryEmitted = false;

	constructor(llmMessages: object, info: RequestTimingRequestInfo, promptBuild: PromptBuildTiming | undefined) {
		this.requestSeq = nextRequestSeq(llmMessages);
		this.info = info;
		this.dispatchedAt = promptBuild?.dispatchedAt;
		this.promptBuiltAt = promptBuild?.promptBuiltAt;
		this.contextEntries = promptBuild?.contextEntries;
		this.streamFnEnteredAt = performance.now();
	}

	/** request-sent: payload handed to the provider client. */
	markRequestSent(): void {
		if (this.requestSentAt !== undefined) return;
		const now = performance.now();
		this.requestSentAt = now;
		const from = this.promptBuiltAt ?? this.streamFnEnteredAt;
		this.emit("request-sent", {
			phaseMs: roundMs(now - from),
			totalMs: this.totalFromDispatch(now),
			contextEntries: this.contextEntries,
		});
	}

	/** Serialized request body size, measured before request-sent so its cost lands in the client-side phase. */
	recordRequestBytes(requestBytes: number | undefined): void {
		this.requestBytes = requestBytes;
	}

	/** first-byte: HTTP response headers received (provider TTFB complete). */
	markFirstByte(): void {
		if (this.firstByteAt !== undefined) return;
		const now = performance.now();
		this.firstByteAt = now;
		const from = this.requestSentAt ?? this.promptBuiltAt ?? this.streamFnEnteredAt;
		this.emit("first-byte", {
			phaseMs: roundMs(now - from),
			// Without a request-sent timestamp (provider never called onPayload) the
			// delta spans from prompt-built, not just the wire wait.
			...(this.requestSentAt === undefined ? { phaseFrom: "prompt-built" } : {}),
			totalMs: this.totalFromDispatch(now),
			requestBytes: this.requestBytes,
		});
	}

	/** first-content-token: first streamed content block (thinking/text/toolcall), which clears the TUI Waiting state. */
	markFirstToken(): void {
		if (this.firstTokenAt !== undefined) return;
		const now = performance.now();
		this.firstTokenAt = now;
		const from = this.firstByteAt ?? this.requestSentAt ?? this.streamFnEnteredAt;
		this.emit("first-token", {
			phaseMs: roundMs(now - from),
			totalMs: this.totalFromDispatch(now),
		});
	}

	/** stream-done: terminal event observed on the provider stream. */
	markStreamDone(stopReason: string, errorMessage?: string): void {
		this.stopReason = stopReason;
		this.errorMessage = errorMessage;
		this.streamDoneAt = performance.now();
	}

	/** Final usage from the completed assistant message; cache read/write answers prompt-cache misses. */
	markUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
		this.usage = usage;
	}

	/** Emit the summary with every known phase delta. Safe to call once; later calls are ignored. */
	emitSummary(outcome: "done" | "aborted" | "failed"): void {
		if (this.summaryEmitted) return;
		this.summaryEmitted = true;
		const doneAt = this.streamDoneAt ?? performance.now();
		const phases: Record<string, number | undefined> = {};
		if (this.dispatchedAt !== undefined && this.promptBuiltAt !== undefined) {
			phases.dispatchToPromptBuiltMs = roundMs(this.promptBuiltAt - this.dispatchedAt);
		}
		const requestStart = this.promptBuiltAt ?? this.streamFnEnteredAt;
		if (this.requestSentAt !== undefined) {
			phases.promptBuiltToRequestSentMs = roundMs(this.requestSentAt - requestStart);
		}
		if (this.requestSentAt !== undefined && this.firstByteAt !== undefined) {
			phases.requestSentToFirstByteMs = roundMs(this.firstByteAt - this.requestSentAt);
		}
		const firstTokenFrom = this.firstByteAt ?? this.requestSentAt;
		if (this.firstTokenAt !== undefined && firstTokenFrom !== undefined) {
			phases.firstByteToFirstTokenMs = roundMs(this.firstTokenAt - firstTokenFrom);
		}
		if (this.firstTokenAt !== undefined) {
			phases.firstTokenToStreamDoneMs = roundMs(doneAt - this.firstTokenAt);
		}
		log.info("request timing summary", {
			phase: "stream-done",
			requestSeq: this.requestSeq,
			outcome,
			...this.identity(),
			contextEntries: this.contextEntries,
			requestBytes: this.requestBytes,
			phases,
			totalMs: this.totalFromDispatch(doneAt) ?? roundMs(doneAt - this.streamFnEnteredAt),
			stopReason: this.stopReason,
			errorMessage: this.errorMessage,
			usage: this.usage,
		});
	}

	private emit(phase: string, fields: Record<string, unknown>): void {
		log.info("request timing", {
			phase,
			requestSeq: this.requestSeq,
			...this.identity(),
			...fields,
		});
	}

	private identity(): Record<string, unknown> {
		return {
			model: this.info.model,
			...(this.info.provider ? { provider: this.info.provider } : {}),
			...(this.info.api ? { api: this.info.api } : {}),
			...(this.info.sessionId ? { sessionId: this.info.sessionId } : {}),
		};
	}

	private totalFromDispatch(at: number): number | undefined {
		return this.dispatchedAt !== undefined ? roundMs(at - this.dispatchedAt) : undefined;
	}
}

/** Event types carrying the first visible model output; these clear the TUI Waiting state. */
const FIRST_TOKEN_EVENT_TYPES = new Set([
	"thinking_start",
	"thinking_delta",
	"text_start",
	"text_delta",
	"toolcall_start",
	"toolcall_delta",
]);

function isRequestTimingFirstTokenEvent(type: string): boolean {
	return FIRST_TOKEN_EVENT_TYPES.has(type);
}

/** Serialized request body size; providers serialize for the wire anyway, but only measure when timing is on. */
function measureRequestBytes(payload: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(payload);
		// UTF-8 bytes as sent on the wire; .length would count UTF-16 code units and underreport non-ASCII prompts.
		return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Instruments the streamFn seam: creates the per-request clock, chains the
 * onPayload/onResponse hooks (request-sent / first-byte), wraps the event
 * stream (first-token, stream-done), and emits a failed summary when auth
 * rejects the request before it is sent.
 */
export function instrumentStreamFn(enabled: RequestTimingEnabled, streamFn: StreamFn): StreamFn {
	return async (model, context, options) => {
		if (!enabled()) {
			return streamFn(model, context, options);
		}
		const llmMessages: object[] = context.messages ?? [];
		const timing = new RequestTiming(
			llmMessages,
			{
				model: model.id,
				provider: model.provider,
				api: model.api,
				sessionId: options?.sessionId,
			},
			takePromptBuild(llmMessages),
		);
		try {
			const stream = await streamFn(model, context, {
				...options,
				onPayload: async (payload, payloadModel) => {
					const next = await options?.onPayload?.(payload, payloadModel);
					// Measured before request-sent: the provider awaits this hook before it
					// opens the HTTP request, so the serialization cost belongs to the
					// client-side build delta, not to request-sent -> first-byte.
					timing.recordRequestBytes(measureRequestBytes(next ?? payload));
					timing.markRequestSent();
					return next;
				},
				onResponse: async (response, responseModel) => {
					timing.markFirstByte();
					await options?.onResponse?.(response, responseModel);
				},
			});
			return wrapRequestTimingEventStream(stream, timing, options?.signal);
		} catch (error) {
			timing.emitSummary("failed");
			throw error;
		}
	};
}

function takePromptBuild(llmMessages: object[]): PromptBuildTiming | undefined {
	const timing = promptBuildByLlmMessages.get(llmMessages);
	if (timing) {
		promptBuildByLlmMessages.delete(llmMessages);
	}
	return timing;
}

/**
 * Wrap a provider event stream so first-byte (fallback via the start event),
 * first-content-token, and the terminal event are timed. The summary is
 * emitted on the terminal event, or as aborted when iteration stops early.
 */
function wrapRequestTimingEventStream(
	stream: AssistantMessageEventStream,
	timing: RequestTiming,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	// Delegates to the provider stream so result/push/end (and instanceof checks)
	// keep working; only iteration is overridden to observe phases.
	const wrapped = Object.create(stream);
	Object.defineProperty(wrapped, Symbol.asyncIterator, {
		value: async function* () {
			try {
				try {
					for await (const event of stream) {
						switch (event?.type) {
							case "start":
								// Providers push start after response headers; used only when onResponse did not fire.
								timing.markFirstByte();
								break;
							case "done":
								timing.markStreamDone(event.message.stopReason, event.message.errorMessage);
								timing.markUsage({
									input: event.message.usage.input,
									output: event.message.usage.output,
									cacheRead: event.message.usage.cacheRead,
									cacheWrite: event.message.usage.cacheWrite,
								});
								timing.emitSummary("done");
								break;
							case "error":
								timing.markStreamDone(event.error.stopReason, event.error.errorMessage);
								timing.markUsage({
									input: event.error.usage.input,
									output: event.error.usage.output,
									cacheRead: event.error.usage.cacheRead,
									cacheWrite: event.error.usage.cacheWrite,
								});
								// A terminal provider error is a failed (or aborted) request, not a completed one.
								timing.emitSummary(event.error.stopReason === "aborted" ? "aborted" : "failed");
								break;
							default:
								if (event && isRequestTimingFirstTokenEvent(event.type)) {
									timing.markFirstToken();
								}
								break;
						}
						yield event;
					}
				} catch (error) {
					// A provider-side crash is a failed request, not a user abort; an
					// abort-driven rejection still reports as aborted. The error is
					// re-thrown so the consumer still sees the failure.
					const errorMessage = error instanceof Error ? error.message : String(error);
					if (signal?.aborted) {
						timing.markStreamDone("aborted", errorMessage);
						timing.emitSummary("aborted");
					} else {
						timing.markStreamDone("error", errorMessage);
						timing.emitSummary("failed");
					}
					throw error;
				}
			} finally {
				// Early termination (abort, hung stream) still reports what was measured.
				timing.emitSummary("aborted");
			}
		},
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return wrapped as unknown as AssistantMessageEventStream;
}

function roundMs(delta: number): number {
	return Math.round(delta * 10) / 10;
}
