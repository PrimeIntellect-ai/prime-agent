export const TELEMETRY_ERROR_CLASSIFIER_REVISION = 1;

export const TELEMETRY_ERROR_MESSAGES = {
	credential_missing: "No API key found for [provider].",
	credential_invalid: "Provider rejected the supplied credentials.",
	credential_expired: "Provider credentials have expired.",
	authentication_rejected: "Provider rejected authentication; the underlying reason is unknown.",
	permission_denied: "Provider denied access to the requested resource.",
	model_access_denied: "The selected model is not accessible.",
	insufficient_balance: "The provider reported insufficient balance.",
	quota_exceeded: "The provider reported an exhausted quota.",
	rate_limited: "Provider rate limit exceeded.",
	network_error: "A network connection failed.",
	timeout: "The operation timed out.",
	provider_unavailable: "The provider is temporarily unavailable.",
	refusal: "The provider refused the request or blocked the response.",
	malformed_response: "Provider returned a malformed response.",
	context_limit: "The request exceeded the model context limit.",
	configuration_error: "The application could not load or use its configuration.",
	filesystem_error: "A local file operation failed.",
	session_unavailable: "The requested session is unavailable.",
	cancelled: "Request was aborted.",
	unknown: "An error occurred; private error details were omitted.",
} as const;

export type TelemetryErrorSubtype = keyof typeof TELEMETRY_ERROR_MESSAGES;

const CODE_SUBTYPES = {
	invalid_api_key: "credential_invalid",
	invalid_token: "credential_invalid",
	invalid_grant: "credential_invalid",
	token_expired: "credential_expired",
	expired_token: "credential_expired",
	missing_api_key: "credential_missing",
	authentication_error: "authentication_rejected",
	unauthorized: "authentication_rejected",
	permission_error: "permission_denied",
	permission_denied: "permission_denied",
	access_denied: "permission_denied",
	forbidden: "permission_denied",
	model_not_found: "model_access_denied",
	model_access_denied: "model_access_denied",
	usage_not_included: "model_access_denied",
	insufficient_funds: "insufficient_balance",
	insufficient_balance: "insufficient_balance",
	insufficient_quota: "quota_exceeded",
	quota_exceeded: "quota_exceeded",
	resource_exhausted: "quota_exceeded",
	rate_limit_error: "rate_limited",
	rate_limit_exceeded: "rate_limited",
	too_many_requests: "rate_limited",
	overloaded_error: "provider_unavailable",
	server_error: "provider_unavailable",
	api_error: "provider_unavailable",
	service_unavailable: "provider_unavailable",
	refusal: "refusal",
	content_filter: "refusal",
	safety: "refusal",
	malformed_response: "malformed_response",
	context_length_exceeded: "context_limit",
	context_window_exceeded: "context_limit",
	ECONNRESET: "network_error",
	ECONNREFUSED: "network_error",
	EHOSTUNREACH: "network_error",
	ENETUNREACH: "network_error",
	ENOTFOUND: "network_error",
	EAI_AGAIN: "network_error",
	EPIPE: "network_error",
	ETIMEDOUT: "timeout",
	UND_ERR_CONNECT_TIMEOUT: "timeout",
	UND_ERR_HEADERS_TIMEOUT: "timeout",
	UND_ERR_BODY_TIMEOUT: "timeout",
	UND_ERR_SOCKET: "network_error",
	ENOENT: "filesystem_error",
	EACCES: "filesystem_error",
	EPERM: "filesystem_error",
	ENOSPC: "filesystem_error",
	EMFILE: "filesystem_error",
	EROFS: "filesystem_error",
	ELOCKED: "filesystem_error",
	missing_session_cwd: "session_unavailable",
	session_import_file_not_found: "session_unavailable",
	session_already_active: "session_unavailable",
	session_recovering: "session_unavailable",
} as const satisfies Record<string, TelemetryErrorSubtype>;

export const TELEMETRY_ERROR_CODES = [...Object.keys(CODE_SUBTYPES), "unknown"];
export const TELEMETRY_ERROR_COMPONENTS = [
	"startup",
	"configuration",
	"authentication",
	"provider",
	"tools",
	"mcp",
	"extensions",
	"daemon",
	"rpc",
	"acp",
	"session",
	"compaction",
	"background",
	"unknown",
] as const;
export const TELEMETRY_ERROR_OPERATIONS = [
	"startup",
	"load",
	"save",
	"refresh",
	"validate",
	"login",
	"logout",
	"discover",
	"request",
	"stream",
	"execute",
	"connect",
	"attach",
	"parse",
	"compact",
	"retry",
	"shutdown",
	"uncaught_exception",
	"unhandled_rejection",
	"unknown",
] as const;
export const TELEMETRY_ERROR_STAGES = [
	"startup",
	"configuration",
	"authentication",
	"model_discovery",
	"model_request",
	"model_stream",
	"tool_execution",
	"session_persistence",
	"compaction",
	"background",
	"shutdown",
	"unknown",
] as const;
export const TELEMETRY_ERROR_RECOVERY_ACTIONS = [
	"automatic_retry",
	"manual_retry",
	"credentials_updated",
	"provider_changed",
	"model_changed",
	"cancelled",
	"none",
	"unknown",
] as const;
export const TELEMETRY_ERROR_RECOVERY_OUTCOMES = [
	"pending",
	"success",
	"failed",
	"cancelled",
	"not_observed",
	"unknown",
] as const;

export type TelemetryErrorComponent = (typeof TELEMETRY_ERROR_COMPONENTS)[number];
export type TelemetryErrorOperation = (typeof TELEMETRY_ERROR_OPERATIONS)[number];
export type TelemetryErrorStage = (typeof TELEMETRY_ERROR_STAGES)[number];
export type TelemetryErrorRecoveryAction = (typeof TELEMETRY_ERROR_RECOVERY_ACTIONS)[number];
export type TelemetryErrorRecoveryOutcome = (typeof TELEMETRY_ERROR_RECOVERY_OUTCOMES)[number];
export type TelemetryErrorClassificationSource =
	| "structured_reason"
	| "http_status"
	| "typed_error"
	| "reviewed_message"
	| "unknown";
export type TelemetryLegacyErrorCategory =
	| "authentication"
	| "rate_limit"
	| "timeout"
	| "context_limit"
	| "network"
	| "provider_unavailable"
	| "other";

export interface TelemetryErrorClassification {
	error_category: TelemetryLegacyErrorCategory;
	error_subtype: TelemetryErrorSubtype;
	error_code: string;
	http_status: number | null;
	classification_source: TelemetryErrorClassificationSource;
	classifier_revision: number;
	diagnostic_message: string;
	retryable: boolean | null;
}

function read(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function safeStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function safeCode(value: unknown): keyof typeof CODE_SUBTYPES | undefined {
	if (typeof value !== "string" || value.length > 80) return undefined;
	if (Object.hasOwn(CODE_SUBTYPES, value)) return value as keyof typeof CODE_SUBTYPES;
	const normalized = value.toLowerCase();
	return Object.hasOwn(CODE_SUBTYPES, normalized) ? (normalized as keyof typeof CODE_SUBTYPES) : undefined;
}

function legacyCategory(message: string): TelemetryLegacyErrorCategory {
	const error = message.toLowerCase();
	if (/\b401\b|\b403\b|auth|api.?key|credential|unauthori[sz]ed|forbidden/.test(error)) return "authentication";
	if (/\b429\b|rate.?limit|quota/.test(error)) return "rate_limit";
	if (/timeout|timed out/.test(error)) return "timeout";
	if (/context|token.*limit|too long|maximum.*length/.test(error)) return "context_limit";
	if (/network|socket|connection|fetch/.test(error)) return "network";
	if (/\b5\d\d\b|overload|unavailable/.test(error)) return "provider_unavailable";
	return "other";
}

const REVIEWED_MESSAGES: Readonly<Record<string, TelemetryErrorSubtype>> = {
	"Request was aborted": "cancelled",
	"The operation was aborted.": "cancelled",
	"The operation was aborted": "cancelled",
	"fetch failed": "network_error",
	"Provider overloaded": "provider_unavailable",
	"Provider rate limit exceeded": "rate_limited",
	"Provider returned a malformed response": "malformed_response",
	"Model refused to respond": "refusal",
	"Response blocked by provider safety filters": "refusal",
	"Provider finish_reason: content_filter": "refusal",
	"Provider finish_reason: network_error": "network_error",
	"Auth storage lock was compromised": "filesystem_error",
	"Failed to acquire auth storage lock": "filesystem_error",
	"Prime CLI config is not enabled": "configuration_error",
};

function reviewedMessageSubtype(message: string): TelemetryErrorSubtype | undefined {
	if (Object.hasOwn(REVIEWED_MESSAGES, message)) return REVIEWED_MESSAGES[message];
	// These are application-owned templates. Variable portions are never retained.
	if (/^No API key for provider: [^\r\n]+$/.test(message)) return "credential_missing";
	if (
		/^No API key found for [^\r\n]+\.\n\nUse \/login to log into a provider via OAuth or API key\. See:\n/.test(
			message,
		)
	)
		return "credential_missing";
	return undefined;
}

function retryable(subtype: TelemetryErrorSubtype): boolean | null {
	if (["network_error", "timeout", "provider_unavailable", "rate_limited"].includes(subtype)) return true;
	if (
		["unknown", "authentication_rejected", "filesystem_error", "configuration_error", "session_unavailable"].includes(
			subtype,
		)
	)
		return null;
	return false;
}

/** Extract only reviewed codes, status values and fixed messages. Raw input never becomes a property. */
export function classifyTelemetryError(error: unknown): TelemetryErrorClassification {
	const rawMessage = typeof error === "string" ? error : (read(error, "errorMessage") ?? read(error, "message"));
	const message = typeof rawMessage === "string" ? rawMessage.slice(0, 16_384) : "";
	let status: number | undefined;
	let code: keyof typeof CODE_SUBTYPES | undefined;
	let kind: unknown;
	const diagnostics = read(error, "diagnostics");
	const nodes: unknown[] = [];
	if (Array.isArray(diagnostics)) {
		for (const diagnostic of diagnostics.slice(-20)) {
			if (read(diagnostic, "type") === "provider_stream_failure") nodes.push(read(diagnostic, "details"));
		}
	}
	nodes.push(error);
	const seen = new Set<unknown>();
	for (let index = 0; index < nodes.length && index < 24; index++) {
		const node = nodes[index];
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		status ??=
			safeStatus(read(node, "status")) ??
			safeStatus(read(node, "statusCode")) ??
			safeStatus(read(node, "httpStatusCode"));
		const candidate =
			safeCode(read(node, "code")) ?? safeCode(read(node, "providerErrorType")) ?? safeCode(read(node, "type"));
		if (
			candidate &&
			(!code ||
				(CODE_SUBTYPES[code] === "authentication_rejected" &&
					CODE_SUBTYPES[candidate] !== "authentication_rejected"))
		)
			code = candidate;
		kind ??= read(node, "kind");
		for (const key of ["error", "info", "cause", "$metadata", "response"]) {
			const nested = read(node, key);
			if (nested && typeof nested === "object" && !seen.has(nested)) nodes.push(nested);
		}
	}

	let subtype: TelemetryErrorSubtype = "unknown";
	let source: TelemetryErrorClassificationSource = "unknown";
	// A server outage is not bad credentials, even if an auth service supplies an auth-shaped code.
	if (status === 408 || status === 504) {
		subtype = "timeout";
		source = "http_status";
	} else if (status !== undefined && status >= 500) {
		subtype = "provider_unavailable";
		source = "http_status";
	} else if (status === 402) {
		subtype =
			code && ["insufficient_balance", "quota_exceeded"].includes(CODE_SUBTYPES[code])
				? CODE_SUBTYPES[code]
				: "unknown";
		source = subtype === "unknown" ? "http_status" : "structured_reason";
	} else if (status === 403) {
		subtype = code && CODE_SUBTYPES[code] === "model_access_denied" ? "model_access_denied" : "permission_denied";
		source = subtype === "model_access_denied" ? "structured_reason" : "http_status";
	} else if (code) {
		subtype = CODE_SUBTYPES[code];
		source = "structured_reason";
	} else if (status === 401) {
		subtype = "authentication_rejected";
		source = "http_status";
	} else if (status === 429) {
		subtype = "rate_limited";
		source = "http_status";
	} else if (kind === "refusal" || kind === "safety" || kind === "malformed_response") {
		subtype = kind === "malformed_response" ? kind : "refusal";
		source = "typed_error";
	} else {
		const name = read(error, "name");
		const reviewed = reviewedMessageSubtype(message);
		if (name === "AbortError" || name === "TimeoutError") {
			subtype = name === "AbortError" ? "cancelled" : "timeout";
			source = "typed_error";
		} else if (reviewed) {
			subtype = reviewed;
			source = "reviewed_message";
		}
	}
	return {
		error_category: legacyCategory(message),
		error_subtype: subtype,
		error_code: code ?? "unknown",
		http_status: status ?? null,
		classification_source: source,
		classifier_revision: TELEMETRY_ERROR_CLASSIFIER_REVISION,
		diagnostic_message: TELEMETRY_ERROR_MESSAGES[subtype],
		retryable: retryable(subtype),
	};
}

export function telemetryErrorProperties(error: unknown): Record<string, string | number | boolean | null> {
	return { ...classifyTelemetryError(error), ...telemetryOriginalErrorDetails(error) };
}

import { telemetryOriginalErrorDetails } from "./telemetry-error-details.js";
