import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

function usageExhaustedMessage(model: Harness["models"][number]): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "You have hit your ChatGPT usage limit. Try again later.",
		}),
		provider: model.provider,
		model: model.id,
		api: model.api,
	};
}

function genericRateLimitMessage(model: Harness["models"][number]): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Provider rate limit exceeded",
		}),
		provider: model.provider,
		model: model.id,
		api: model.api,
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "rate_limit", providerErrorType: "rate_limit_exceeded", status: 429 },
			},
		],
	};
}

describe("Codex home rotation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("marks the exhausted daemon-wide chain entry stale before retrying", async () => {
		const harness = await createHarness({
			provider: "openai-codex",
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		harness.authStorage.setRuntimeApiKeyChain("openai-codex", [
			{ key: "first-token", label: "first-home" },
			{ key: "second-token", label: "second-home" },
		]);
		harness.setResponses([usageExhaustedMessage(harness.models[0]), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(2);
		await expect(harness.authStorage.getApiKey("openai-codex")).resolves.toBe("second-token");
		expect(harness.eventsOfType("auth_stale")).toMatchObject([
			{
				provider: "openai-codex",
				sourceTokens: [{ source: "runtime_chain" }],
			},
		]);
	});

	it("retries a transient rate limit without consuming the active home", async () => {
		const harness = await createHarness({
			provider: "openai-codex",
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		harness.authStorage.setRuntimeApiKeyChain("openai-codex", [
			{ key: "first-token", label: "first-home" },
			{ key: "second-token", label: "second-home" },
		]);
		harness.setResponses([genericRateLimitMessage(harness.models[0]), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(2);
		await expect(harness.authStorage.getApiKey("openai-codex")).resolves.toBe("first-token");
		expect(harness.eventsOfType("auth_stale")).toHaveLength(0);
	});
});
