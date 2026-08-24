import type * as NodeOs from "node:os";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
let _os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_os = m as typeof NodeOs;
	});
}

import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.js";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import {
	classifyStreamFailure,
	extractStreamFailureInfo,
	formatStreamFailureMessage,
	recordStreamFailure,
} from "../utils/stream-failure.js";
import {
	applyProviderStreamStall,
	createProviderStreamLiveness,
	isProviderStreamStalledError,
	observeProviderAsyncIterable,
	type ProviderStreamLiveness,
	type ProviderStreamStalledError,
} from "../utils/stream-liveness.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
}

type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isRetryableError(
	status: number,
	errorText: string,
	failureKind?: ReturnType<typeof classifyStreamFailure>,
): boolean {
	if (failureKind === "resource_exhausted") return false;
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let liveness: ProviderStreamLiveness | undefined;
		let terminalEventPushed = false;
		const cleanStreamingScratch = (): void => {
			for (const block of output.content) {
				delete (block as { partialJson?: string }).partialJson;
			}
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			const websocketRequestId = options?.sessionId || createCodexRequestId();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			const transport = options?.transport || "auto";
			const onStall = (error: ProviderStreamStalledError) => {
				cleanStreamingScratch();
				applyProviderStreamStall(output, error);
				if (!terminalEventPushed) {
					terminalEventPushed = true;
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
				}
			};
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(options?.sessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				try {
					await processWebSocketStream(
						resolveCodexWebSocketUrl(model.baseUrl),
						body,
						websocketHeaders,
						output,
						stream,
						model,
						() => {
							websocketStarted = true;
						},
						options,
						onStall,
					);

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}
					terminalEventPushed = true;
					stream.push({
						type: "done",
						reason: output.stopReason as "stop" | "length" | "toolUse",
						message: output,
					});
					stream.end();
					return;
				} catch (error) {
					const aborted = options?.signal?.aborted;
					if (aborted || isCodexNonTransportError(error) || isProviderStreamStalledError(error)) {
						throw error;
					}
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: transport,
							fallbackTransport: websocketStarted ? undefined : "sse",
							eventsEmitted: websocketStarted,
							phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
							requestBytes: new TextEncoder().encode(bodyJson).byteLength,
						}),
					);
					recordWebSocketFailure(options?.sessionId, error);
					if (websocketStarted) {
						throw error;
					}
					recordWebSocketSseFallback(options?.sessionId);
				}
			}

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				liveness = createProviderStreamLiveness({
					identity: { provider: model.provider, model: model.id, transport: "sse" },
					host: options?.streamLiveness,
					signal: options?.signal,
					onStall,
				});

				try {
					response = await fetch(resolveCodexUrl(model.baseUrl), {
						method: "POST",
						headers: sseHeaders,
						body: bodyJson,
						signal: liveness.signal,
					});
					liveness.observe({ type: "headers", receivedBytes: 0 });
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}
					liveness.markError();
					liveness.close();

					const info = await parseErrorResponse(response);
					if (attempt < MAX_RETRIES && isRetryableError(response.status, info.message, info.kind)) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}

					throw new CodexApiError(info.friendlyMessage || info.message, {
						code: info.code,
						status: response.status,
						limitClass: info.limitClass,
						resetAt: info.resetAt,
						resetInSeconds: info.resetInSeconds,
						creditsUnavailable: info.creditsUnavailable,
					});
				} catch (error) {
					const stalled = liveness.stalledError();
					if (stalled) throw stalled;
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					if (error instanceof CodexApiError) {
						const failureKind = classifyStreamFailure(error.code, error.status);
						if (!isRetryableError(error.status ?? 0, error.message, failureKind)) throw error;
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					liveness.markError();
					liveness.close();
					// Network errors are retryable
					if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}
			const activeLiveness = liveness;
			if (!activeLiveness) throw new Error("Codex SSE liveness was not initialized");

			stream.push({ type: "start", partial: output });
			await processStream(response, output, stream, model, options, activeLiveness);

			activeLiveness.markFinal();
			if (activeLiveness.callerAborted()) {
				throw new Error("Request was aborted");
			}

			terminalEventPushed = true;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			cleanStreamingScratch();
			const stalled = liveness?.stalledError();
			if (stalled) {
				applyProviderStreamStall(output, stalled);
			} else if (isProviderStreamStalledError(error)) {
				applyProviderStreamStall(output, error);
			} else {
				output.stopReason = liveness?.callerAborted() || options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = formatStreamFailureMessage(error);
				recordStreamFailure(model, output, error);
			}
			if (!terminalEventPushed) {
				terminalEventPushed = true;
				stream.push({
					type: "error",
					reason: output.stopReason === "aborted" ? "aborted" : "error",
					error: output,
				});
				stream.end();
			}
		} finally {
			liveness?.close();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAICodexResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): RequestBody {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null });
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id.startsWith("gpt-5.5") || model.id.startsWith("gpt-5.6") ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexResponsesOptions,
	liveness?: ProviderStreamLiveness,
): Promise<void> {
	if (!liveness) throw new Error("Codex SSE liveness was not initialized");
	await processResponsesStream(
		observeProviderAsyncIterable(mapCodexEvents(parseSSE(response)), liveness),
		output,
		stream,
		model,
		{
			serviceTier: options?.serviceTier,
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			onLivenessObservation: liveness.observe,
		},
	);
}

interface ParsedCodexError {
	message: string;
	friendlyMessage?: string;
	code?: string;
	status?: number;
	kind: ReturnType<typeof classifyStreamFailure>;
	limitClass?: string;
	resetAt?: number;
	resetInSeconds?: number;
	creditsUnavailable?: boolean;
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly status?: number;
	readonly payload?: Record<string, unknown>;
	readonly limitClass?: string;
	readonly resetAt?: number;
	readonly resetInSeconds?: number;
	readonly creditsUnavailable?: boolean;

	constructor(
		message: string,
		options?: {
			code?: string;
			status?: number;
			payload?: Record<string, unknown>;
			limitClass?: string;
			resetAt?: number;
			resetInSeconds?: number;
			creditsUnavailable?: boolean;
			cause?: unknown;
		},
	) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.status = options?.status;
		this.payload = options?.payload;
		this.limitClass = options?.limitClass;
		this.resetAt = options?.resetAt;
		this.resetInSeconds = options?.resetInSeconds;
		this.creditsUnavailable = options?.creditsUnavailable;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

const CODEX_SAFE_QUOTA_HEADERS = {
	"x-codex-active-limit": "X-Codex-Active-Limit",
	"x-codex-credits-has-credits": "X-Codex-Credits-Has-Credits",
	"x-codex-reset-at": "X-Codex-Reset-At",
	"x-codex-reset-in-seconds": "X-Codex-Reset-In-Seconds",
} as const;

function safeCodexQuotaHeaders(...values: unknown[]): Record<string, string> {
	const safeHeaders: Record<string, string> = {};
	for (const value of values) {
		if (value && typeof (value as Headers).get === "function") {
			for (const [name, canonicalName] of Object.entries(CODEX_SAFE_QUOTA_HEADERS)) {
				const headerValue = (value as Headers).get(name);
				if (headerValue !== null) safeHeaders[canonicalName] = headerValue;
			}
			continue;
		}
		const headers = recordValue(value);
		if (!headers) continue;
		for (const [name, headerValue] of Object.entries(headers)) {
			const canonicalName = CODEX_SAFE_QUOTA_HEADERS[name.toLowerCase() as keyof typeof CODEX_SAFE_QUOTA_HEADERS];
			if (canonicalName && typeof headerValue === "string") safeHeaders[canonicalName] = headerValue;
		}
	}
	return safeHeaders;
}

function sanitizeCodexErrorPayload(payload: unknown): Record<string, unknown> | undefined {
	const root = recordValue(payload);
	if (!root) return undefined;
	const sanitized = { ...root };
	if ("headers" in sanitized) {
		const headers = safeCodexQuotaHeaders(sanitized.headers);
		if (Object.keys(headers).length > 0) sanitized.headers = headers;
		else delete sanitized.headers;
	}
	for (const key of ["error", "response"] as const) {
		const nested = sanitizeCodexErrorPayload(sanitized[key]);
		if (nested) sanitized[key] = nested;
	}
	return sanitized;
}

function parseCodexErrorPayload(payload: unknown, fallbackStatus?: number): ParsedCodexError {
	const root = recordValue(payload) ?? {};
	const nestedError = recordValue(root.error);
	const response = recordValue(root.response);
	const responseError = recordValue(response?.error);
	const nestedErrorResponse = recordValue(nestedError?.response);
	const quotaHeaders = safeCodexQuotaHeaders(
		root.headers,
		nestedError?.headers,
		nestedErrorResponse?.headers,
		response?.headers,
		responseError?.headers,
	);
	const merged = { ...root };
	delete merged.error;
	delete merged.response;
	delete merged.headers;
	Object.assign(merged, nestedError ?? {}, responseError ?? {});
	delete merged.headers;
	if (Object.keys(quotaHeaders).length > 0) merged.headers = quotaHeaders;
	if (merged.status === undefined && merged.status_code === undefined && merged.statusCode === undefined) {
		const nestedStatus =
			response?.status ??
			response?.status_code ??
			response?.statusCode ??
			nestedErrorResponse?.status ??
			nestedErrorResponse?.status_code ??
			nestedErrorResponse?.statusCode;
		if (nestedStatus !== undefined) merged.status_code = nestedStatus;
	}
	const code =
		typeof merged.code === "string"
			? merged.code
			: typeof merged.type === "string" && merged.type !== "error"
				? merged.type
				: undefined;
	const message = typeof merged.message === "string" ? merged.message : undefined;
	const status =
		fallbackStatus ?? numberValue(merged.status) ?? numberValue(merged.status_code) ?? numberValue(merged.statusCode);
	const diagnosticError = Object.assign(new Error(message || code || "Codex request failed"), {
		status,
		code,
		error: merged,
	});
	const info = extractStreamFailureInfo(diagnosticError);
	return {
		message: message || code || "Codex request failed",
		code,
		status,
		kind: info.kind,
		limitClass: info.limitClass ?? (info.kind === "resource_exhausted" ? code : undefined),
		resetAt: info.resetAt,
		resetInSeconds: info.resetInSeconds,
		creditsUnavailable: info.creditsUnavailable,
	};
}

function addCodexQuotaHeaders(payload: unknown, response: Response): unknown {
	const activeLimit = response.headers.get("x-codex-active-limit");
	const creditsHasCredits = response.headers.get("x-codex-credits-has-credits");
	if (activeLimit === null && creditsHasCredits === null) return payload;
	const root = recordValue(payload);
	const headers = safeCodexQuotaHeaders(root?.headers);
	if (activeLimit !== null) headers["X-Codex-Active-Limit"] = activeLimit;
	if (creditsHasCredits !== null) headers["X-Codex-Credits-Has-Credits"] = creditsHasCredits;
	return { ...(root ?? {}), headers };
}

async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const info = parseCodexErrorPayload(event);
			throw new CodexApiError(info.message, {
				code: info.code,
				status: info.status,
				limitClass: info.limitClass,
				resetAt: info.resetAt,
				resetInSeconds: info.resetInSeconds,
				creditsUnavailable: info.creditsUnavailable,
				payload: sanitizeCodexErrorPayload(event),
			});
		}

		if (type === "response.failed") {
			const info = parseCodexErrorPayload(event);
			throw new CodexApiError(info.message || "Codex response failed", {
				code: info.code,
				status: info.status,
				limitClass: info.limitClass,
				resetAt: info.resetAt,
				resetInSeconds: info.resetInSeconds,
				creditsUnavailable: info.creditsUnavailable,
				payload: sanitizeCodexErrorPayload(event),
			});
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown } }).response;
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

function findSSEBoundary(buffer: string): { index: number; length: number } | undefined {
	const lfIndex = buffer.indexOf("\n\n");
	const crlfIndex = buffer.indexOf("\r\n\r\n");
	if (lfIndex === -1 && crlfIndex === -1) return undefined;
	if (lfIndex === -1 || (crlfIndex !== -1 && crlfIndex < lfIndex)) {
		return { index: crlfIndex, length: 4 };
	}
	return { index: lfIndex, length: 2 };
}

function parseSSEChunk(chunk: string): Record<string, unknown> | undefined {
	const dataLines = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	if (dataLines.length === 0) return undefined;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch (cause) {
		throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
			cause,
			payload: data,
		});
	}
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				buffer += decoder.decode();
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let boundary = findSSEBoundary(buffer);
			while (boundary) {
				const chunk = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const event = parseSSEChunk(chunk);
				if (event) yield event;
				boundary = findSSEBoundary(buffer);
			}
		}

		// Dispatch a final event even when the server closes without a blank line.
		buffer += "\n\n";
		let boundary = findSSEBoundary(buffer);
		while (boundary) {
			const chunk = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary.length);
			const event = parseSSEChunk(chunk);
			if (event) yield event;
			boundary = findSSEBoundary(buffer);
		}
	} finally {
		// Best-effort stream teardown: the reader may already be closed or errored.
		try {
			await reader.cancel();
		} catch {
			// Already closed.
		}
		try {
			reader.releaseLock();
		} catch {
			// Lock already released.
		}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) {
		closeEntry(entry);
	}
	websocketSessionCache.clear();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

function getWebSocketConstructor(): WebSocketConstructor | null {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {
		// Already closed.
	}
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocketLike> {
	const WebSocketCtor = getWebSocketConstructor();
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			const error = extractWebSocketError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onClose: WebSocketListener = (event) => {
			const error = extractWebSocketCloseError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close(1000, "aborted");
			reject(new Error("Request was aborted"));
		};

		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal);
		return {
			socket,
			reused: false,
			release: ({ keep } = {}) => {
				if (keep === false) {
					closeWebSocketSilently(socket);
					return;
				}
				closeWebSocketSilently(socket);
			},
		};
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal);
	const entry: CachedWebSocketConnection = { socket, busy: true };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) {
					websocketSessionCache.delete(sessionId);
				}
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

async function* parseWebSocket(socket: WebSocketLike, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: text,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			await new Promise<void>((resolve) => {
				pending = resolve;
			});
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	options?: OpenAICodexResponsesOptions,
	onStall?: (error: ProviderStreamStalledError) => void,
): Promise<void> {
	const liveness = createProviderStreamLiveness({
		identity: { provider: model.provider, model: model.id, transport: "websocket" },
		host: options?.streamLiveness,
		signal: options?.signal,
		onStall,
	});
	let acquired: Awaited<ReturnType<typeof acquireWebSocket>>;
	try {
		acquired = await acquireWebSocket(url, headers, options?.sessionId, liveness.signal);
	} catch (error) {
		liveness.markError();
		liveness.close();
		throw error;
	}
	const { socket, entry, reused, release } = acquired;
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		liveness.observe({ type: "headers", receivedBytes: 0 });
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				observeProviderAsyncIterable(mapCodexEvents(parseWebSocket(socket, liveness.signal)), liveness),
				output,
				stream,
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				onLivenessObservation: liveness.observe,
			},
		);
		liveness.markFinal();
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
			}).filter((item) => item.type !== "function_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		const stalled = liveness.stalledError();
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		if (stalled) throw stalled;
		throw error;
	} finally {
		release({ keep: keepConnection });
		liveness.close();
	}
}

// ============================================================================
// Error Handling
// ============================================================================

async function parseErrorResponse(response: Response): Promise<ParsedCodexError> {
	const raw = await response.text();
	let parsed: unknown;
	try {
		parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
	} catch {
		parsed = undefined;
	}

	const info = parseCodexErrorPayload(addCodexQuotaHeaders(parsed, response), response.status);
	const message =
		info.code || info.message !== "Codex request failed"
			? info.message
			: raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;
	if (info.kind === "resource_exhausted") {
		const payload = recordValue(parsed);
		const err = recordValue(payload?.error) ?? payload;
		const plan = typeof err?.plan_type === "string" ? ` (${err.plan_type.toLowerCase()} plan)` : "";
		const mins = info.resetInSeconds === undefined ? undefined : Math.max(0, Math.round(info.resetInSeconds / 60));
		const when = mins === undefined ? "" : ` Try again in ~${mins} min.`;
		friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
	}

	return { ...info, message, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}

function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session_id", requestId);
	return headers;
}
