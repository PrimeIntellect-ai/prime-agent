import { getLogger } from "../log.js";
import type { AssistantMessage } from "../types.js";
import { appendAssistantMessageDiagnostic, extractDiagnosticError } from "./diagnostics.js";

/**
 * Shared classification and reporting for provider stream failures, so no
 * provider collapses a specific cause (refusal, safety filter, overload, ...)
 * into a generic string before it is logged and persisted.
 */

export type StreamFailureKind =
	| "refusal"
	| "safety"
	| "overloaded"
	| "rate_limit"
	| "server_error"
	| "auth"
	| "invalid_request"
	| "malformed_response"
	| "degenerate_output"
	| "unknown";

export interface StreamFailureInfo {
	kind: StreamFailureKind;
	/** Provider's own error/stop identifier, e.g. "overloaded_error" or "SAFETY". */
	providerErrorType?: string;
	status?: number;
	requestId?: string;
	/** Truncated raw provider payload for post-mortems. */
	raw?: string;
}

export class StreamFailureError extends Error {
	readonly info: StreamFailureInfo;

	constructor(message: string, info: StreamFailureInfo) {
		super(message);
		this.name = "StreamFailureError";
		this.info = info;
	}
}

const KIND_MESSAGES: Record<StreamFailureKind, string> = {
	refusal: "Model refused to respond",
	safety: "Response blocked by provider safety filters",
	overloaded: "Provider overloaded",
	rate_limit: "Provider rate limit exceeded",
	server_error: "Provider server error",
	auth: "Provider authentication failed",
	invalid_request: "Provider rejected the request",
	malformed_response: "Provider returned a malformed response",
	degenerate_output: "Model stopped making progress and repeated itself",
	unknown: "Provider stream failed",
};

/** Build a user-facing message like "Provider overloaded (overloaded_error, 529) [request_id: req_abc]". */
export function streamFailureMessage(info: StreamFailureInfo, detail?: string): string {
	const qualifiers = [info.providerErrorType, info.status !== undefined ? String(info.status) : undefined]
		.filter(Boolean)
		.join(", ");
	let message = KIND_MESSAGES[info.kind];
	if (qualifiers) message += ` (${qualifiers})`;
	if (detail) message += `: ${detail}`;
	if (info.requestId) message += ` [request_id: ${info.requestId}]`;
	return message;
}

export function classifyStreamFailure(providerErrorType?: string, status?: number): StreamFailureKind {
	const type = providerErrorType?.toLowerCase() ?? "";
	if (type === "refusal") return "refusal";
	if (/sensitive|safety|prohibited_content|blocklist|spii|recitation|content.?filter|guardrail|flagged/.test(type)) {
		return "safety";
	}
	if (type.includes("overloaded") || status === 529) return "overloaded";
	if (type.includes("rate_limit") || type.includes("throttl") || status === 429) return "rate_limit";
	if (/authentication|permission|unauthorized/.test(type) || status === 401 || status === 403) return "auth";
	if (type.includes("invalid_request") || type.includes("not_found_error") || status === 400 || status === 404) {
		return "invalid_request";
	}
	if (type.includes("malformed")) return "malformed_response";
	if (
		type.includes("api_error") ||
		type.includes("server_error") ||
		type.includes("unavailable") ||
		(status !== undefined && status >= 500)
	) {
		return "server_error";
	}
	return "unknown";
}

/**
 * Failure for a stream that terminated with a provider stop/finish reason that
 * maps to "error" (e.g. Anthropic "refusal", Gemini "SAFETY"). Providers call
 * this instead of throwing a generic error, so the raw reason survives.
 */
export function streamFailureFromStopReason(
	rawStopReason: string | undefined,
	extra?: Pick<StreamFailureInfo, "requestId">,
): StreamFailureError {
	const info: StreamFailureInfo = {
		kind: rawStopReason ? classifyStreamFailure(rawStopReason) : "unknown",
		providerErrorType: rawStopReason,
		requestId: extra?.requestId,
	};
	if (info.kind === "unknown" && /malformed/i.test(rawStopReason ?? "")) info.kind = "malformed_response";
	const message = rawStopReason
		? streamFailureMessage(info)
		: streamFailureMessage(info, "stream ended with an error and no stop reason");
	return new StreamFailureError(message, info);
}

const MAX_RAW_LENGTH = 2000;

export function truncateRawPayload(raw: string): string {
	return raw.length > MAX_RAW_LENGTH ? `${raw.slice(0, MAX_RAW_LENGTH)}…` : raw;
}

function extractStreamFailureParts(error: unknown): { info: StreamFailureInfo; detail?: string } {
	if (error instanceof StreamFailureError) return { info: error.info };
	if (!(error instanceof Error)) return { info: { kind: "unknown" } };

	const err = error as Error & {
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		requestID?: unknown;
		request_id?: unknown;
		headers?: unknown;
		error?: unknown;
		$metadata?: { requestId?: unknown };
	};

	const status =
		typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined;

	// Error bodies come nested differently per SDK: Anthropic/OpenAI expose
	// `error.error = {type|code, message}` (sometimes doubly nested).
	let body = err.error as { type?: unknown; code?: unknown; message?: unknown; error?: unknown } | undefined;
	if (body && typeof body === "object" && body.error && typeof body.error === "object") {
		body = body.error as { type?: unknown; code?: unknown; message?: unknown };
	}
	const bodyType = body && typeof body === "object" ? (body.type ?? body.code) : undefined;
	const bodyMessage = body && typeof body === "object" ? body.message : undefined;
	const providerErrorType =
		typeof bodyType === "string"
			? bodyType
			: typeof err.code === "string"
				? err.code
				: err.name !== "Error" && err.name !== "StreamFailureError"
					? err.name
					: undefined;

	const headers = err.headers;
	const headerRequestId =
		headers && typeof (headers as Headers).get === "function"
			? ((headers as Headers).get("request-id") ?? (headers as Headers).get("x-request-id"))
			: headers && typeof headers === "object"
				? ((headers as Record<string, unknown>)["request-id"] ??
					(headers as Record<string, unknown>)["x-request-id"])
				: undefined;
	const rawRequestId = err.requestID ?? err.request_id ?? err.$metadata?.requestId ?? headerRequestId;
	const requestId = typeof rawRequestId === "string" ? rawRequestId : undefined;

	return {
		info: {
			kind: classifyStreamFailure(providerErrorType ?? error.message, status),
			providerErrorType,
			status,
			requestId,
		},
		detail: typeof bodyMessage === "string" ? bodyMessage : undefined,
	};
}

/**
 * Best-effort extraction of structured failure info from any thrown value:
 * StreamFailureError, provider SDK errors (Anthropic/OpenAI APIError, AWS SDK
 * exceptions, Google ApiError), or plain errors.
 */
export function extractStreamFailureInfo(error: unknown): StreamFailureInfo {
	return extractStreamFailureParts(error).info;
}

/**
 * User-facing message for a thrown stream error: a classified one-liner with
 * the provider's own short message, never the raw payload/trace. Unrecognized
 * errors pass through verbatim so their text (which downstream retry matching
 * may depend on) is preserved.
 */
export function formatStreamFailureMessage(error: unknown): string {
	if (error instanceof StreamFailureError) return error.message;
	const { info, detail } = extractStreamFailureParts(error);
	if (info.kind === "unknown") {
		return error instanceof Error ? error.message : JSON.stringify(error);
	}
	return streamFailureMessage(info, detail);
}

const log = getLogger("ai.provider");

/**
 * Record a terminal stream failure on the message (structured diagnostic that
 * persists to session JSONL) and emit one structured log line. Call from the
 * provider's terminal catch after stopReason/errorMessage are set; no-op for
 * user-initiated aborts.
 */
export function recordStreamFailure(
	model: { provider: string; id: string; api: string },
	output: AssistantMessage,
	error: unknown,
): void {
	if (output.stopReason !== "error") return;
	const info = extractStreamFailureInfo(error);
	appendAssistantMessageDiagnostic(output, {
		type: "provider_stream_failure",
		timestamp: Date.now(),
		error: extractDiagnosticError(error),
		details: { ...info },
	});
	const rawMessage = error instanceof Error ? error.message : String(error);
	log.error("provider stream failure", {
		provider: model.provider,
		model: model.id,
		api: model.api,
		kind: info.kind,
		providerErrorType: info.providerErrorType,
		status: info.status,
		requestId: info.requestId,
		message: output.errorMessage,
		// errorMessage is user-facing and concise; keep the raw cause for debugging.
		cause: rawMessage === output.errorMessage ? undefined : truncateRawPayload(rawMessage),
	});
}
