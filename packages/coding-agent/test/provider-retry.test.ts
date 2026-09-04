import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { completeWithProviderRetry } from "../src/core/provider-retry.js";

function providerError(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "500 Internal Server Error",
		timestamp: Date.now(),
	};
}

describe("completeWithProviderRetry", () => {
	it("returns an aborted result instead of the provider error when cancelled during backoff", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const result = await completeWithProviderRetry(async () => providerError(), {
			policy: { enabled: true, maxRetries: 3, baseDelayMs: 60_000, maxRetryDelayMs: 0 },
			signal: controller.signal,
		});

		expect(result.stopReason).toBe("aborted");
	});
});
