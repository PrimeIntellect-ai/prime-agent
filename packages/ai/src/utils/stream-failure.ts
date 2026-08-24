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
	| "resource_exhausted"
	| "rate_limit"
	| "server_error"
	| "auth"
	| "invalid_request"
	| "malformed_response"
	| "unknown";

export interface StreamFailureInfo {
	kind: StreamFailureKind;
	/** Provider's own error/stop identifier, e.g. "overloaded_error" or "SAFETY". */
	providerErrorType?: string;
	status?: number;
	requestId?: string;
	/** Stable provider quota class, retained only for resource exhaustion failures. */
	limitClass?: string;
	/** Unix timestamp in seconds for the next quota reset. */
	resetAt?: number;
	/** Seconds until the next quota reset when supplied by the provider. */
	resetInSeconds?: number;
	/** True when the provider explicitly reports that credits are unavailable. */
	creditsUnavailable?: boolean;
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

function redactProviderSensitiveText(value: string): string {
	return value
		.replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/(\bbearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/(\b(?:x-)?api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

const KIND_MESSAGES: Record<StreamFailureKind, string> = {
	refusal: "Model refused to respond",
	safety: "Response blocked by provider safety filters",
	overloaded: "Provider overloaded",
	resource_exhausted: "Provider resource limit reached",
	rate_limit: "Provider rate limit exceeded",
	server_error: "Provider server error",
	auth: "Provider authentication failed",
	invalid_request: "Provider rejected the request",
	malformed_response: "Provider returned a malformed response",
	unknown: "Provider stream failed",
};

/** Build a user-facing message like "Provider overloaded (overloaded_error, 529) [request_id: req_abc]". */
export function streamFailureMessage(info: StreamFailureInfo, detail?: string): string {
	const qualifiers = [info.providerErrorType, info.status !== undefined ? String(info.status) : undefined]
		.filter(Boolean)
		.join(", ");
	let message = KIND_MESSAGES[info.kind];
	if (qualifiers) message += ` (${qualifiers})`;
	if (detail) message += `: ${redactProviderSensitiveText(detail)}`;
	if (info.requestId) message += ` [request_id: ${info.requestId}]`;
	return message;
}

export function classifyStreamFailure(providerErrorType?: string, status?: number): StreamFailureKind {
	const type = providerErrorType?.toLowerCase() ?? "";
	if (type === "refusal") return "refusal";
	if (
		type.includes("usage_limit") ||
		type.includes("usage_not_included") ||
		type.includes("insufficient_quota") ||
		type.includes("quota_exceeded") ||
		type.includes("quota_exhaust") ||
		type.includes("credits_unavailable") ||
		type.includes("credit_exhaust") ||
		type.includes("spend_control") ||
		type.includes("workspace_member_usage_limit")
	) {
		return "resource_exhausted";
	}
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unixSeconds(value: unknown): number | undefined {
	const number = finiteNumber(value);
	if (number !== undefined) {
		return Math.round(number > 100_000_000_000 ? number / 1000 : number);
	}
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return unixSeconds(numeric);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
}

function durationSeconds(value: unknown): number | undefined {
	const number = finiteNumber(value);
	if (number !== undefined) return number;
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function firstValue(sources: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
	for (const source of sources) {
		for (const key of keys) {
			if (source[key] !== undefined) return source[key];
		}
	}
	return undefined;
}

function firstHeaderValue(sources: readonly Record<string, unknown>[], name: string): string | undefined {
	const normalizedName = name.toLowerCase();
	for (const source of sources) {
		const headers = source.headers;
		if (headers && typeof (headers as Headers).get === "function") {
			const value = (headers as Headers).get(name);
			if (value !== null) return value;
		}
		const headerRecord = asRecord(headers);
		if (!headerRecord) continue;
		for (const [key, value] of Object.entries(headerRecord)) {
			if (key.toLowerCase() === normalizedName && typeof value === "string") return value;
		}
	}
	return undefined;
}

function safeQuotaLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return /^[A-Za-z0-9_.:-]{1,64}$/.test(normalized) ? normalized : undefined;
}

function extractResourceMetadata(
	sources: readonly Record<string, unknown>[],
): Pick<StreamFailureInfo, "limitClass" | "resetAt" | "resetInSeconds" | "creditsUnavailable"> {
	const activeLimit = safeQuotaLabel(firstHeaderValue(sources, "x-codex-active-limit"));
	const rawLimitClass =
		activeLimit ?? firstValue(sources, ["limitClass", "limit_class", "rate_limit_type", "quota_type"]);
	const rawResetAt =
		firstValue(sources, ["resetAt", "reset_at", "resetsAt", "resets_at"]) ??
		firstHeaderValue(sources, "x-codex-reset-at");
	const rawResetInSeconds =
		firstValue(sources, [
			"resetInSeconds",
			"reset_in_seconds",
			"resetsInSeconds",
			"resets_in_seconds",
			"reset_after_seconds",
			"reset_seconds",
		]) ?? firstHeaderValue(sources, "x-codex-reset-in-seconds");
	const creditsHasCredits = firstHeaderValue(sources, "x-codex-credits-has-credits");
	const rawCreditsUnavailable = firstValue(sources, ["creditsUnavailable", "credits_unavailable"]);
	const rawCreditsAvailable = firstValue(sources, ["creditsAvailable", "credits_available"]);
	const resetAt = unixSeconds(rawResetAt);
	const suppliedResetInSeconds = durationSeconds(rawResetInSeconds);
	const resetInSeconds =
		suppliedResetInSeconds !== undefined
			? Math.max(0, Math.round(suppliedResetInSeconds))
			: resetAt !== undefined
				? Math.max(0, resetAt - Math.floor(Date.now() / 1000))
				: undefined;
	const creditsUnavailable =
		creditsHasCredits !== undefined
			? creditsHasCredits.trim().toLowerCase() === "false"
			: typeof rawCreditsUnavailable === "boolean"
				? rawCreditsUnavailable
				: typeof rawCreditsAvailable === "boolean"
					? !rawCreditsAvailable
					: undefined;

	return {
		limitClass: safeQuotaLabel(rawLimitClass),
		resetAt,
		resetInSeconds,
		creditsUnavailable,
	};
}

function extractStreamFailureParts(error: unknown): { info: StreamFailureInfo; detail?: string } {
	if (error instanceof StreamFailureError) return { info: error.info };
	if (!(error instanceof Error)) return { info: { kind: "unknown" } };

	const err = error as Error & {
		status?: unknown;
		statusCode?: unknown;
		status_code?: unknown;
		code?: unknown;
		requestID?: unknown;
		request_id?: unknown;
		headers?: unknown;
		error?: unknown;
		$metadata?: { requestId?: unknown };
	};

	const status =
		typeof err.status === "number"
			? err.status
			: typeof err.statusCode === "number"
				? err.statusCode
				: typeof err.status_code === "number"
					? err.status_code
					: undefined;

	// Error bodies come nested differently per SDK: Anthropic/OpenAI expose
	// `error.error = {type|code, message}` (sometimes doubly nested).
	let body = asRecord(err.error);
	if (body?.error && typeof body.error === "object") body = asRecord(body.error);
	const sources = [err as unknown as Record<string, unknown>, ...(body ? [body] : [])];
	const bodyType = body?.type ?? body?.code;
	const bodyMessage = body?.message;
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
	const resourceMetadata = extractResourceMetadata(sources);
	let kind = classifyStreamFailure(providerErrorType ?? error.message, status);
	if (kind === "rate_limit" && resourceMetadata.creditsUnavailable === true) kind = "resource_exhausted";
	if (kind === "resource_exhausted" && resourceMetadata.limitClass === undefined) {
		resourceMetadata.limitClass = providerErrorType;
	}

	return {
		info: {
			kind,
			providerErrorType,
			status,
			requestId,
			...resourceMetadata,
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
	if (error instanceof StreamFailureError) return redactProviderSensitiveText(error.message);
	const { info, detail } = extractStreamFailureParts(error);
	if (info.kind === "unknown") {
		const message = redactProviderSensitiveText(
			error instanceof Error ? error.message : (JSON.stringify(error) ?? String(error)),
		);
		const qualifiers = [info.providerErrorType, info.status !== undefined ? String(info.status) : undefined]
			.filter(Boolean)
			.join(", ");
		return qualifiers ? `Provider stream failed (${qualifiers}): ${message}` : message;
	}
	return streamFailureMessage(info, detail);
}

function extractRedactedDiagnosticError(error: unknown): ReturnType<typeof extractDiagnosticError> {
	const diagnostic = extractDiagnosticError(error);
	return {
		...diagnostic,
		message: redactProviderSensitiveText(diagnostic.message),
		stack: diagnostic.stack ? redactProviderSensitiveText(diagnostic.stack) : undefined,
	};
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
		error: extractRedactedDiagnosticError(error),
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
		cause:
			redactProviderSensitiveText(rawMessage) === output.errorMessage
				? undefined
				: truncateRawPayload(redactProviderSensitiveText(rawMessage)),
	});
}
