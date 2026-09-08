import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-5930 structured authentication evidence", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([
		[402, "insufficient_funds", false],
		[402, "insufficient_quota", false],
		[403, "authentication_error", false],
		[503, "authentication_error", false],
		[401, undefined, false],
		[401, "invalid_api_key", true],
		[401, "token_expired", true],
	] as const)(
		"only adds credential recovery guidance for specific credential evidence (%s, %s)",
		async (status, providerErrorType, shouldUpdateCredentials) => {
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
		},
	);
});
