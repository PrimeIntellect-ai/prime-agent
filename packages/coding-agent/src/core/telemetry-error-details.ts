import {
	findTelemetrySafeErrorMessageId,
	getTelemetrySafeErrorMessage,
	getTelemetrySafeErrorMessageSource,
	TELEMETRY_SAFE_ERROR_CODES,
	TELEMETRY_SAFE_ERROR_MESSAGES,
	TELEMETRY_SAFE_ERROR_SIGNALS,
	TELEMETRY_SYSTEM_ERROR_MESSAGE_IDS,
	type TelemetrySafeErrorMessageId,
} from "./telemetry-error-policy.js";

export const MAX_TELEMETRY_ERROR_MESSAGE = 4_096;
const REDACTED = "[REDACTED]";

export const TELEMETRY_ERROR_TYPES = [
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"AbortError",
	"TimeoutError",
	"SystemError",
	"StreamFailureError",
	"APIError",
	"AuthenticationError",
	"PermissionDeniedError",
	"RateLimitError",
	"NotFoundError",
	"InternalServerError",
	"ConnectionError",
	"custom",
	"unknown",
] as const;

function read(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

export function redactTelemetryCredentials(value: string): string {
	return value
		.replace(/\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|\[[0-?]*[ -/]*[@-~])/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\ud800-\udfff]/gu, "\ufffd")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
		.replace(
			/(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n,]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s/)[0]} ${REDACTED}`)
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
		.replace(
			/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|token)["']?\s*[:=]\s*)(\[REDACTED\]|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&}\]]+)/gi,
			(_match, prefix: string, secret: string) =>
				`${prefix}${secret.startsWith('"') ? `"${REDACTED}"` : secret.startsWith("'") ? `'${REDACTED}'` : REDACTED}`,
		)
		.replace(/(--(?:api[_-]?key|token|password|secret)\s+)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi, `$1${REDACTED}`)
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{15,}|AKIA[0-9A-Z]{16})\b/g,
			REDACTED,
		)
		.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED);
}

export function sanitizeTelemetryErrorMessage(value: unknown, messageId?: unknown) {
	if (typeof value !== "string" || value.length > MAX_TELEMETRY_ERROR_MESSAGE) return undefined;
	const message = getTelemetrySafeErrorMessage(messageId);
	if (message === undefined || message !== value || redactTelemetryCredentials(message) !== message) return undefined;
	return {
		error_message: message,
		error_message_id: messageId as TelemetrySafeErrorMessageId,
		error_message_source: getTelemetrySafeErrorMessageSource(messageId as TelemetrySafeErrorMessageId),
		error_message_length: [...message].length,
		error_message_length_lower_bound: false,
		error_message_truncated: false,
		error_message_redacted: false,
	};
}

const safeCodes = new Set<string>(TELEMETRY_SAFE_ERROR_CODES);
const safeSignals = new Set<string>(TELEMETRY_SAFE_ERROR_SIGNALS);

function numericCode(value: number): string {
	if (!Number.isInteger(value)) return "unknown";
	if (value >= 400 && value <= 599) return `http_${value}`;
	if (value === -32700 || (value >= -32603 && value <= -32600) || (value >= -32099 && value <= -32000))
		return `code_${value}`;
	return "unknown";
}

export function sanitizeTelemetryErrorCode(value: unknown): string {
	if (typeof value === "number") return numericCode(value);
	if (typeof value !== "string" || value.length > 80) return "unknown";
	if (safeCodes.has(value)) return value;
	if (safeCodes.has(value.toLowerCase())) return value.toLowerCase();
	if (/^-?\d{1,6}$/.test(value)) return numericCode(Number(value));
	if (/^http_[45]\d{2}$/.test(value)) return value;
	if (/^code_-\d{5}$/.test(value)) return numericCode(Number(value.slice(5)));
	if (/^process_exit_(?:0|[1-9]\d{0,2})$/.test(value) && Number(value.slice(13)) <= 255) return value;
	if (value.startsWith("signal_") && safeSignals.has(value.slice(7))) return value;
	return "unknown";
}

function errorNodes(error: unknown): unknown[] {
	const nodes = [error];
	const seen = new Set<unknown>();
	for (let index = 0; index < nodes.length && index < 24; index++) {
		const node = nodes[index];
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		for (const key of ["cause", "info", "error", "$metadata", "response"]) {
			const nested = read(node, key);
			if (nested && typeof nested === "object" && !nodes.includes(nested)) nodes.push(nested);
		}
		const diagnostics = read(node, "diagnostics");
		if (Array.isArray(diagnostics)) {
			for (const diagnostic of diagnostics.slice(-20))
				if (read(diagnostic, "type") === "provider_stream_failure") nodes.push(read(diagnostic, "details"));
		}
	}
	return nodes.slice(0, 24);
}

export function telemetryOriginalErrorDetails(error: unknown): Record<string, string | number | boolean | null> {
	const message = typeof error === "string" ? error : (read(error, "errorMessage") ?? read(error, "message"));
	let messageDetails =
		typeof message === "string"
			? sanitizeTelemetryErrorMessage(message, findTelemetrySafeErrorMessageId(message))
			: undefined;
	let code = "unknown";
	let type: string = "unknown";
	let fallbackCode = "unknown";
	for (const node of errorNodes(error)) {
		const candidate = sanitizeTelemetryErrorCode(read(node, "code") ?? read(node, "providerErrorType"));
		if (candidate !== "unknown") {
			if (["authentication_error", "api_error", "server_error", "error"].includes(candidate))
				fallbackCode = candidate;
			else if (code === "unknown") code = candidate;
		}
		const name = read(node, "name");
		if (typeof name === "string" && type === "unknown")
			type = TELEMETRY_ERROR_TYPES.includes(name as (typeof TELEMETRY_ERROR_TYPES)[number]) ? name : "custom";
		const exitCode = read(node, "exitCode");
		if (
			code === "unknown" &&
			typeof exitCode === "number" &&
			Number.isInteger(exitCode) &&
			exitCode >= 0 &&
			exitCode <= 255
		)
			code = `process_exit_${exitCode}`;
		const signal = read(node, "signal");
		if (code === "unknown" && typeof signal === "string" && safeSignals.has(signal)) code = `signal_${signal}`;
	}
	if (code === "unknown") code = fallbackCode;
	if (!messageDetails && Object.hasOwn(TELEMETRY_SYSTEM_ERROR_MESSAGE_IDS, code)) {
		const id = TELEMETRY_SYSTEM_ERROR_MESSAGE_IDS[code as keyof typeof TELEMETRY_SYSTEM_ERROR_MESSAGE_IDS];
		messageDetails = sanitizeTelemetryErrorMessage(TELEMETRY_SAFE_ERROR_MESSAGES[id], id);
	}
	return {
		error_code_group: code,
		error_type: type,
		error_event_kind: "occurrence",
		...messageDetails,
	};
}
