import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const litellmError =
	"400 litellm.BadRequestError: OpenAIException - Requested token count exceeds the model's maximum context length of 262144 tokens. You requested a total of 270128 tokens: 261936 tokens from the input messages and 8192 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.. Received Model Group=qwen3.8-27b-nvfp4";

describe("LiteLLM context overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			models: [{ id: "litellm-fixture", contextWindow: 262144, maxTokens: 8192 }],
			settings: {
				autoRefine: { enabled: false },
				compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 50 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Earlier findings recorded.")]);
		await harness.session.prompt("Earlier context. ".repeat(100));
		return harness;
	}

	it.each([
		["LiteLLM rejection", litellmError],
		["known overflow control", "prompt is too long: 270128 tokens > 262144 maximum"],
	])("compacts and continues after %s without retrying the unchanged request", async (_name, errorMessage) => {
		const harness = await setup();
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Summary of earlier findings.");
			},
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Recovered.");
			},
		]);

		await harness.session.prompt("Continue the task using the earlier findings. ".repeat(8));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["overflow"]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "overflow", aborted: false, willRetry: true, result: expect.any(Object) }),
		]);
		await vi.waitFor(() => {
			expect(harness.session.messages.at(-1)).toEqual(
				expect.objectContaining({ content: [{ type: "text", text: "Recovered." }], stopReason: "stop" }),
			);
		});
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(requests).toHaveLength(2);
		expect(getMessageText(requests[0].messages[0])).toContain("<conversation>");
		expect(requests[1].messages.map(getMessageText).join("\n")).toContain("Summary of earlier findings.");
		expect(
			requests[1].messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("retries a token-rate-limit rejection without compacting", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit: too many tokens" }),
			fauxAssistantMessage("Recovered after rate limit."),
		]);

		await harness.session.prompt("Continue the task.");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Recovered after rate limit.");
		expect(harness.faux.state.callCount).toBe(3);
	});
});
