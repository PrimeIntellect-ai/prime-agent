export const MAX_TELEMETRY_ERROR_MESSAGE = 4_096;
const MAX_INSPECTED_MESSAGE = 1_000_000;
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

function boundedText(value: string, maximum: number): { text: string; length: number; truncated: boolean } {
	let length = 0;
	let end = 0;
	for (const character of value) {
		if (length === maximum) return { text: value.slice(0, end), length, truncated: true };
		end += character.length;
		length++;
	}
	return { text: value, length, truncated: false };
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

export function sanitizeTelemetryErrorMessage(value: string) {
	const inspected = boundedText(value, MAX_INSPECTED_MESSAGE);
	const redacted = redactTelemetryCredentials(inspected.text);
	const output = boundedText(redacted, MAX_TELEMETRY_ERROR_MESSAGE);
	return {
		error_message: output.text,
		error_message_length: inspected.length,
		error_message_length_lower_bound: inspected.truncated,
		error_message_truncated: inspected.truncated || output.truncated,
		error_message_redacted: redacted !== inspected.text,
	};
}

export function sanitizeTelemetryErrorCode(value: unknown): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000) return `code_${value}`;
	if (typeof value === "string" && /^-?\d{1,7}$/.test(value) && Math.abs(Number(value)) <= 1_000_000)
		return `code_${Number(value)}`;
	if (typeof value !== "string" || value.length > 80 || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)) return "unknown";
	if (redactTelemetryCredentials(value) !== value || /[A-Za-z0-9]{32,}/.test(value)) return "unknown";
	return value;
}

function errorNodes(error: unknown): unknown[] {
	const nodes = [error];
	const seen = new Set<unknown>();
	for (let index = 0; index < nodes.length && index < 24; index++) {
		const node = nodes[index];
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		for (const key of ["cause", "info", "error"]) {
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
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let cause = error;
	for (let index = 0; index < 5 && cause && !seen.has(cause); index++) {
		seen.add(cause);
		const message = typeof cause === "string" ? cause : (read(cause, "errorMessage") ?? read(cause, "message"));
		if (typeof message === "string") {
			const bounded = boundedText(message, MAX_INSPECTED_MESSAGE + 1).text;
			if (!messages.includes(bounded)) messages.push(bounded);
		}
		cause = read(cause, "cause");
	}
	let code = "unknown";
	let type: string = "unknown";
	let fallbackCode = "unknown";
	for (const node of errorNodes(error)) {
		if (!messages.length) {
			const nestedMessage = read(node, "message");
			if (typeof nestedMessage === "string")
				messages.push(boundedText(nestedMessage, MAX_INSPECTED_MESSAGE + 1).text);
		}
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
			Number.isSafeInteger(exitCode) &&
			Math.abs(exitCode) <= 1_000_000
		)
			code = `process_exit_${exitCode}`;
		const signal = read(node, "signal");
		if (code === "unknown" && typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal))
			code = `signal_${signal}`;
	}
	return {
		error_code_group: code === "unknown" ? fallbackCode : code,
		error_type: type,
		error_event_kind: "occurrence",
		...(messages.length ? sanitizeTelemetryErrorMessage(messages.join("\nCaused by: ")) : {}),
		...(cause && !seen.has(cause) ? { error_message_truncated: true, error_message_length_lower_bound: true } : {}),
	};
}
