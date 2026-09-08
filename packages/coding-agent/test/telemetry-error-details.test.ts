import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { telemetryErrorProperties } from "../src/core/telemetry-error-classification.js";
import {
	redactTelemetryCredentials,
	sanitizeTelemetryErrorCode,
	sanitizeTelemetryErrorMessage,
	telemetryOriginalErrorDetails,
} from "../src/core/telemetry-error-details.js";

const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures/telemetry-error-redaction.json", import.meta.url), "utf8"),
) as Array<{
	name: string;
	input: string;
	expected: string;
}>;

describe("original error message diagnostics", () => {
	it.each(fixtures)("redacts portable fixture: $name", ({ input, expected }) => {
		expect(redactTelemetryCredentials(input)).toBe(expected);
		expect(redactTelemetryCredentials(expected)).toBe(expected);
	});

	it("bounds Unicode code points and reports exact original length", () => {
		const message = "😕".repeat(4_097);
		expect(sanitizeTelemetryErrorMessage(message)).toEqual({
			error_message: "😕".repeat(4_096),
			error_message_length: 4_097,
			error_message_length_lower_bound: false,
			error_message_truncated: true,
			error_message_redacted: false,
		});
	});

	it("redacts before truncation even when a credential crosses the boundary", () => {
		const message = `${"x".repeat(4_000)} password="${"synthetic-canary".repeat(500)}" failed`;
		const result = sanitizeTelemetryErrorMessage(message);
		expect(result.error_message).toBe(`${"x".repeat(4_000)} password="[REDACTED]" failed`);
		expect(result.error_message_redacted).toBe(true);
		expect(result.error_message_truncated).toBe(false);
		expect(result.error_message_length).toBe(message.length);
	});

	it("marks an honest lower bound when inspection reaches its work limit", () => {
		const result = sanitizeTelemetryErrorMessage(`password="${"x".repeat(1_000_010)}`);
		expect(result).toMatchObject({
			error_message: 'password="[REDACTED]"',
			error_message_length: 1_000_000,
			error_message_length_lower_bound: true,
			error_message_truncated: true,
			error_message_redacted: true,
		});
	});

	it.each([
		[{ code: "ENOENT", message: "Cannot open the local session file." }, "ENOENT", "filesystem_error"],
		[
			{ code: "DAEMON_HANDSHAKE_FAILED", message: "Worker did not complete the handshake." },
			"DAEMON_HANDSHAKE_FAILED",
			"unknown",
		],
		[{ exitCode: 17, message: "Child process exited with code 17." }, "process_exit_17", "unknown"],
		[{ signal: "SIGKILL", message: "Worker was terminated." }, "signal_SIGKILL", "unknown"],
		[{ code: -32600, message: "Invalid RPC envelope." }, "code_-32600", "unknown"],
	])("preserves non-HTTP machine codes without inventing a status", (error, code, subtype) => {
		expect(telemetryErrorProperties(error)).toMatchObject({
			error_code_group: code,
			error_subtype: subtype,
			http_status: null,
			error_message: error.message,
			error_event_kind: "occurrence",
		});
	});

	it("retains unknown wording and bounded cause chains without uploading arbitrary body or stack fields", () => {
		const cause = Object.assign(new TypeError("Unexpected worker result"), { code: "WORKER_BAD_RESULT" });
		const error = Object.assign(new Error("Session could not be started", { cause }), {
			body: "private body canary",
			stack: "private stack canary",
			requestId: "private identifier canary",
		});
		const details = telemetryOriginalErrorDetails(error);
		expect(details).toMatchObject({
			error_code_group: "WORKER_BAD_RESULT",
			error_type: "Error",
			error_message: "Session could not be started\nCaused by: Unexpected worker result",
		});
		expect(JSON.stringify(details)).not.toContain("canary");
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
			error_message: "Worker failed",
			error_code_group: "unknown",
		});
	});
	it("keeps a nested SDK message when the wrapper has no message, without serializing its body", () => {
		expect(
			telemetryOriginalErrorDetails({
				error: { message: "Socket ended before handshake", code: "WORKER_EOF", body: "body canary" },
			}),
		).toMatchObject({ error_message: "Socket ended before handshake", error_code_group: "WORKER_EOF" });
	});

	it.each(["sk-synthetic_canary_0123456789", "message with spaces", "x".repeat(81), "https://example.test"])(
		"rejects a code that is not a bounded machine identifier: %s",
		(value) => expect(sanitizeTelemetryErrorCode(value)).toBe("unknown"),
	);
	it("preserves application codes outside the reviewed subtype list", () => {
		expect(sanitizeTelemetryErrorCode("DAEMON_HANDSHAKE_FAILED")).toBe("DAEMON_HANDSHAKE_FAILED");
		expect(sanitizeTelemetryErrorCode("-32600")).toBe("code_-32600");
	});
});
