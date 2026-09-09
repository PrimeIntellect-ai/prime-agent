import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { telemetryErrorProperties } from "../src/core/telemetry-error-classification.js";
import {
	redactTelemetryCredentials,
	sanitizeTelemetryErrorCode,
	sanitizeTelemetryErrorMessage,
	telemetryOriginalErrorDetails,
} from "../src/core/telemetry-error-details.js";
import {
	getTelemetrySafeErrorMessage,
	TELEMETRY_SAFE_ERROR_CODES,
	TELEMETRY_SAFE_ERROR_MESSAGES,
} from "../src/core/telemetry-error-policy.js";

const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures/telemetry-error-redaction.json", import.meta.url), "utf8"),
) as Array<{
	name: string;
	input: string;
	expected: string;
}>;

const privacyFixtures = JSON.parse(
	readFileSync(new URL("./fixtures/telemetry-error-privacy.json", import.meta.url), "utf8"),
) as {
	message_cases: Array<{ name: string; value: string; id?: string; expected_id: string | null }>;
	error_cases: Array<{ name: string; error: unknown; expected_id: string | null; expected_code: string }>;
	code_cases: Array<{ value: unknown; expected: string }>;
};

describe("prompt-safe error diagnostics", () => {
	it.each(fixtures)("redacts portable fixture: $name", ({ input, expected }) => {
		expect(redactTelemetryCredentials(input)).toBe(expected);
		expect(redactTelemetryCredentials(expected)).toBe(expected);
	});

	it.each(privacyFixtures.message_cases)(
		"validates portable message boundary: $name",
		({ value, id, expected_id }) => {
			const result = sanitizeTelemetryErrorMessage(value, id);
			if (expected_id === null) expect(result).toBeUndefined();
			else expect(result).toMatchObject({ error_message_id: expected_id, error_message: value });
			expect(JSON.stringify(result) ?? "").not.toMatch(/PROMPT_CANARY|synthetic-secret-canary/);
		},
	);

	it.each(privacyFixtures.error_cases)(
		"does not echo portable error content: $name",
		({ error, expected_id, expected_code }) => {
			const details = telemetryOriginalErrorDetails(error);
			expect(details.error_code_group).toBe(expected_code);
			expect(details.error_message_id ?? null).toBe(expected_id);
			expect(details.error_message).toBe(getTelemetrySafeErrorMessage(expected_id));
			expect(JSON.stringify(details)).not.toContain("PROMPT_CANARY");
		},
	);

	it.each(privacyFixtures.code_cases)("validates portable error code: $value", ({ value, expected }) => {
		expect(sanitizeTelemetryErrorCode(value)).toBe(expected);
		expect(sanitizeTelemetryErrorCode(expected)).toBe(expected);
	});

	it.each(Object.entries(TELEMETRY_SAFE_ERROR_MESSAGES))(
		"preserves reviewed message %s without runtime substitutions",
		(id, message) => {
			const details = sanitizeTelemetryErrorMessage(message, id);
			expect(details).toMatchObject({
				error_message: message,
				error_message_id: id,
				error_message_source: id.startsWith("system_") ? "system_template" : "reviewed_literal",
				error_message_length: [...message].length,
				error_message_length_lower_bound: false,
				error_message_truncated: false,
				error_message_redacted: false,
			});
		},
	);

	it.each([null, undefined, 123, {}, [], "😕".repeat(4_097), `password="${"x".repeat(1_000_010)}`])(
		"rejects nonstrings and large untrusted messages without creating partial text",
		(value) => expect(sanitizeTelemetryErrorMessage(value, "prime_challenge_expired")).toBeUndefined(),
	);

	it("does not accept arbitrary error text after credentials are removed", () => {
		const value = redactTelemetryCredentials("Provider rejected PROMPT_CANARY api_key=synthetic-secret-canary");
		expect(value).toContain("[REDACTED]");
		expect(sanitizeTelemetryErrorMessage(value, "provider_invalid_request")).toBeUndefined();
	});

	it("keeps every reviewed code valid and rejects unreviewed vocabulary", () => {
		for (const code of TELEMETRY_SAFE_ERROR_CODES) expect(sanitizeTelemetryErrorCode(code)).toBe(code);
		expect(sanitizeTelemetryErrorCode("DAEMON_HANDSHAKE_FAILED")).toBe("unknown");
	});

	it.each([
		[{ code: "ENOENT", message: "Cannot open the local session file." }, "ENOENT", "filesystem_error"],
		[
			{ code: "session_recovering", message: "Active session PROMPT_CANARY is recovering; retry shortly" },
			"session_recovering",
			"session_unavailable",
		],
		[{ exitCode: 17, message: "Child process exited with code 17." }, "process_exit_17", "unknown"],
		[{ signal: "SIGKILL", message: "Worker was terminated." }, "signal_SIGKILL", "unknown"],
		[{ code: -32600, message: "Invalid RPC envelope." }, "code_-32600", "unknown"],
	])("preserves non-HTTP machine codes without inventing a status", (error, code, subtype) => {
		expect(telemetryErrorProperties(error)).toMatchObject({
			error_code_group: code,
			error_subtype: subtype,
			http_status: null,
			error_event_kind: "occurrence",
		});
		expect(JSON.stringify(telemetryErrorProperties(error))).not.toContain("PROMPT_CANARY");
	});

	it("retains a cause's reviewed code without sending any cause wording, body or stack", () => {
		const cause = Object.assign(new TypeError("Unexpected worker result canary"), {
			code: "command_result_uncertain",
		});
		const error = Object.assign(new Error("Session could not be started", { cause }), {
			body: "private body canary",
			stack: "private stack canary",
			requestId: "private identifier canary",
		});
		const details = telemetryOriginalErrorDetails(error);
		expect(details).toMatchObject({
			error_code_group: "command_result_uncertain",
			error_type: "Error",
		});
		expect(details.error_message).toBeUndefined();
		expect(JSON.stringify(details)).not.toContain("canary");
	});

	it.each([
		[{ status: 401 }, "http_401", 401, "authentication_rejected"],
		[{ response: { status: 503 } }, "http_503", 503, "provider_unavailable"],
		[{ $metadata: { httpStatusCode: 429 } }, "http_429", 429, "rate_limited"],
		[{ cause: { response: { statusCode: 504 } } }, "http_504", 504, "timeout"],
		[{ type: "invalid_api_key", status: 401 }, "invalid_api_key", 401, "credential_invalid"],
		[{ error: { type: "rate_limit_error" } }, "rate_limit_error", null, "rate_limited"],
	])(
		"groups status-only and reviewed structured errors without changing their classification",
		(error, code, status, subtype) => {
			expect(telemetryErrorProperties(error)).toMatchObject({
				error_code_group: code,
				error_subtype: subtype,
				http_status: status,
			});
		},
	);

	it.each([
		[{ code: "daemon_shutdown_in_progress", status: 503, type: "server_error" }, "daemon_shutdown_in_progress"],
		[{ cause: { code: "ECONNRESET" }, response: { status: 502 } }, "ECONNRESET"],
		[{ code: -32600, status: 400, type: "api_error" }, "code_-32600"],
	])("prefers the actual application or system code over classifier and HTTP fallbacks", (error, code) => {
		expect(telemetryErrorProperties(error).error_code_group).toBe(code);
	});

	it.each([
		{ message: "HTTP 401 returned by a worker" },
		{ status: "401" },
		{ status: 200 },
		{ status: Number.NaN },
		{ type: "unreviewed_provider_type" },
	])("keeps unknown groups when structured evidence is missing or invalid", (error) => {
		expect(telemetryErrorProperties(error)).toMatchObject({ error_code_group: "unknown", http_status: null });
	});

	it("bounds malformed, cyclical causes and contains throwing getters", () => {
		const error = { message: "Worker failed", cause: {} };
		error.cause = error;
		Object.defineProperty(error, "code", {
			get() {
				throw new Error("getter canary");
			},
		});
		expect(telemetryOriginalErrorDetails(error)).toMatchObject({
			error_code_group: "unknown",
		});
		expect(telemetryOriginalErrorDetails(error).error_message).toBeUndefined();
	});
	it("keeps nested SDK codes while dropping nested messages and bodies", () => {
		expect(
			telemetryOriginalErrorDetails({
				error: { message: "Socket ended before handshake canary", code: "api_error", body: "body canary" },
			}),
		).toEqual({ error_code_group: "api_error", error_type: "unknown", error_event_kind: "occurrence" });
	});

	it.each(["sk-synthetic_canary_0123456789", "message with spaces", "x".repeat(81), "https://example.test"])(
		"rejects a code that is not a bounded machine identifier: %s",
		(value) => expect(sanitizeTelemetryErrorCode(value)).toBe("unknown"),
	);
	it("preserves reviewed application codes outside the subtype list", () => {
		expect(sanitizeTelemetryErrorCode("command_result_uncertain")).toBe("command_result_uncertain");
		expect(sanitizeTelemetryErrorCode("-32600")).toBe("code_-32600");
	});
});
