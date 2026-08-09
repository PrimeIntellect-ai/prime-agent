import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { shouldAutoContinueTruncatedResponse } from "../src/core/agent-session.js";
import { createHarness, getAssistantTexts } from "./suite/harness.js";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial answer" }],
		api: "openai",
		provider: "openai",
		model: "test-model",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

describe("shouldAutoContinueTruncatedResponse", () => {
	it("continues non-empty text cut off by the output-token limit", () => {
		const message = assistant({ stopReason: "length", content: [{ type: "text", text: "and then..." }] });
		expect(shouldAutoContinueTruncatedResponse(message, 0)).toBe(true);
	});

	it("rejects normal, empty, whitespace-only, and tool-call-only endings", () => {
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "stop" }), 0)).toBe(false);
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "length", content: [] }), 0)).toBe(false);
		expect(
			shouldAutoContinueTruncatedResponse(
				assistant({ stopReason: "length", content: [{ type: "text", text: "   " }] }),
				0,
			),
		).toBe(false);
		expect(
			shouldAutoContinueTruncatedResponse(
				assistant({
					stopReason: "length",
					content: [{ type: "toolCall", id: "call-1", name: "ipython", arguments: {} }],
				}),
				0,
			),
		).toBe(false);
	});

	it("enforces the continuation budget", () => {
		const message = assistant({ stopReason: "length" });
		expect(shouldAutoContinueTruncatedResponse(message, 2, 3)).toBe(true);
		expect(shouldAutoContinueTruncatedResponse(message, 3, 3)).toBe(false);
	});

	it("runs the hidden session-owned continuation and resets the next chain", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("partial one", { stopReason: "length" }),
				fauxAssistantMessage("completed one"),
				fauxAssistantMessage("partial two", { stopReason: "length" }),
				fauxAssistantMessage("completed two"),
			]);

			await harness.session.prompt("first long answer");
			await harness.session.waitForIdle();
			await harness.session.prompt("second long answer");
			await harness.session.waitForIdle();

			expect(getAssistantTexts(harness)).toEqual(["partial one", "completed one", "partial two", "completed two"]);
			const continuations = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "length_continuation_prompt",
			);
			expect(continuations).toHaveLength(2);
			expect(continuations).toEqual([
				expect.objectContaining({
					display: false,
					details: { chainId: expect.any(String), sequence: 1 },
				}),
				expect.objectContaining({
					display: false,
					details: { chainId: expect.any(String), sequence: 1 },
				}),
			]);
			const chainIds = continuations.map(
				(message) => (message as { details?: { chainId?: string } }).details?.chainId,
			);
			expect(chainIds[0]).not.toBe(chainIds[1]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("records an explicit terminal outcome when the continuation budget is exhausted", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("partial 0", { stopReason: "length" }),
				fauxAssistantMessage("partial 1", { stopReason: "length" }),
				fauxAssistantMessage("partial 2", { stopReason: "length" }),
				fauxAssistantMessage("partial 3", { stopReason: "length" }),
			]);

			await harness.session.prompt("very long answer");
			await harness.session.waitForIdle();

			const prompts = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "length_continuation_prompt",
			);
			expect(prompts).toHaveLength(3);
			const exhausted = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "length_continuation_exhausted",
			);
			expect(exhausted).toEqual([
				expect.objectContaining({
					display: true,
					details: { chainId: expect.any(String), attempts: 3 },
				}),
			]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
