import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { completeWithProviderRetry, providerRetryDelay } from "../src/core/provider-retry.js";

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

	it("makes a single attempt when the policy disables retries", async () => {
		let attempts = 0;
		const result = await completeWithProviderRetry(
			async () => {
				attempts++;
				return providerError();
			},
			{ policy: { enabled: false, maxRetries: 3, baseDelayMs: 1, maxRetryDelayMs: 60_000 } },
		);

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("clamps uncapped server delays to Node's max timer instead of overflowing setTimeout", () => {
		const ninetyDaysMs = 90 * 24 * 3600 * 1000;
		expect(providerRetryDelay(1, ninetyDaysMs, { baseDelayMs: 2000, maxRetryDelayMs: 0 })).toEqual({
			kind: "wait",
			delayMs: 2_147_483_647,
		});
	});
});
