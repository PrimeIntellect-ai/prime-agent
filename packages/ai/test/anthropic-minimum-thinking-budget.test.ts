import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { adjustMaxTokensForThinking } from "../src/providers/simple-options.js";

describe("budget-based Anthropic thinking minimum", () => {
	it.each([1025, 1500, 2048, 4096])("sends a valid thinking budget under a %i-token ceiling", async (maxTokens) => {
		let payload: { max_tokens: number; thinking: { type: string; budget_tokens: number } } | undefined;
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), maxTokens };
		const stream = streamSimpleAnthropic(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				apiKey: "dummy-key",
				reasoning: "low",
				maxTokens,
				onPayload(value) {
					payload = value as typeof payload;
					throw new Error("Captured before network dispatch");
				},
			},
		);
		await stream.result();
		expect(payload).toBeDefined();
		expect(payload!.thinking.type).toBe("enabled");
		expect(payload!.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
		expect(payload!.thinking.budget_tokens).toBeLessThan(payload!.max_tokens);
		expect(payload!.max_tokens).toBe(maxTokens);
	});

	it.each([1, 476, 1024])("rejects an impossible %i-token model limit before constructing a request", (maxTokens) => {
		expect(() => adjustMaxTokensForThinking(maxTokens, maxTokens, "low")).toThrow("thinking requires at least");
	});

	it("honors the thinking minimum for an undersized custom budget", () => {
		expect(adjustMaxTokensForThinking(4096, 8192, "low", { low: 476 })).toEqual({
			maxTokens: 5120,
			thinkingBudget: 1024,
		});
	});
});
