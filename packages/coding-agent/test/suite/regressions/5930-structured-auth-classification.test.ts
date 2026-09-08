import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTelemetryError } from "../../../src/core/telemetry-error-classification.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-5930 structured authentication evidence", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([
		[402, "insufficient_funds", false, "insufficient_balance"],
		[402, "insufficient_quota", false, "quota_exceeded"],
		[402, undefined, false, "unknown"],
		[402, "invalid_api_key", false, "unknown"],
		[403, "authentication_error", false, "permission_denied"],
		[403, "invalid_api_key", false, "permission_denied"],
		[503, "authentication_error", false, "provider_unavailable"],
		[500, "invalid_api_key", false, "provider_unavailable"],
		[504, "authentication_error", false, "timeout"],
		[401, undefined, true, "authentication_rejected"],
		[401, "authentication_error", true, "authentication_rejected"],
		[401, "invalid_api_key", true, "credential_invalid"],
		[401, "token_expired", true, "credential_expired"],
		[401, "insufficient_quota", false, "quota_exceeded"],
		[401, "model_access_denied", false, "model_access_denied"],
		[401, "permission_denied", false, "permission_denied"],
		[undefined, undefined, true, "unknown"],
		[undefined, "authentication_error", true, "authentication_rejected"],
		[undefined, "insufficient_funds", false, "insufficient_balance"],
	] as const)(
		"preserves structured auth recovery without misclassifying the rejection reason (%s, %s)",
		async (status, providerErrorType, shouldUpdateCredentials, subtype) => {
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(harness);
			const failure = fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider API key authentication failed",
			});
			failure.diagnostics = [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { status, providerErrorType, kind: "auth" },
				},
			];
			harness.setResponses([failure]);
			await harness.session.prompt("Synthetic request");
			const message = harness.session.messages.find(
				(entry): entry is AssistantMessage => entry.role === "assistant",
			);
			expect(message?.errorMessage?.includes("Run /login to update credentials.")).toBe(shouldUpdateCredentials);
			expect(harness.eventsOfType("auth_stale").length > 0).toBe(shouldUpdateCredentials);
			expect(classifyTelemetryError(message).error_subtype).toBe(subtype);
		},
	);

	it("does not rotate credentials based only on unstructured 401 prose", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const failure = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid API key",
		});
		harness.setResponses([failure]);
		await harness.session.prompt("Synthetic request");
		expect(harness.eventsOfType("auth_stale")).toHaveLength(0);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(true);
		expect(classifyTelemetryError(failure)).toMatchObject({
			error_subtype: "unknown",
			classification_source: "unknown",
			http_status: null,
		});
	});

	it("keeps credentials available when a structured auth failure recovers on retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider authentication failed" });
		failure.diagnostics = [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "auth", status: 401 },
			},
		];
		harness.setResponses([failure, fauxAssistantMessage("Recovered")]);
		await harness.session.prompt("Synthetic request");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.eventsOfType("auth_stale")).toHaveLength(0);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(true);
		expect(classifyTelemetryError(failure).error_subtype).toBe("authentication_rejected");
	});
});
