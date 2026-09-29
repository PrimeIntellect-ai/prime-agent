import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogle } from "../src/providers/google.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, Usage } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

const context: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

function components(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Drives one Responses request against a stubbed SSE endpoint that reports the given usage block. */
async function collectResponsesUsage(usage: Record<string, unknown>): Promise<Usage> {
	const sse = `data: ${JSON.stringify({
		type: "response.completed",
		response: { status: "completed", usage },
	})}\n\ndata: [DONE]\n\n`;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);

	const model = getFixtureModel<"openai-responses">("openai", "gpt-5.4")!;
	const result = await streamOpenAIResponses(model, context, { apiKey: "test-key" }).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return result.usage;
}

describe("openai-responses usage normalization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps totalTokens equal to the sum of components when the wire omits it", async () => {
		const usage = await collectResponsesUsage({
			input_tokens: 20,
			output_tokens: 8,
			input_tokens_details: { cached_tokens: 5 },
		});

		expect(usage).toMatchObject({ input: 15, output: 8, cacheRead: 5, cacheWrite: 0 });
		expect(usage.totalTokens).toBe(components(usage));
		expect(usage.totalTokens).toBe(28);
	});

	it("does not produce negative input when cached tokens exceed input tokens", async () => {
		const usage = await collectResponsesUsage({
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 35,
			input_tokens_details: { cached_tokens: 20 },
		});

		expect(usage.input).toBe(0);
		expect(usage.cost.input).toBe(0);
		expect(usage.cost.total).toBeGreaterThanOrEqual(0);
		expect(usage.totalTokens).toBe(components(usage));
	});

	it("falls back to a zeroed usage when no usage block is present", async () => {
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: { status: "completed" },
		})}\n\ndata: [DONE]\n\n`;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const model = getFixtureModel<"openai-responses">("openai", "gpt-5.4")!;
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key" }).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.usage.totalTokens).toBe(components(result.usage));
	});
});

/** Drives one Gemini request against a stubbed SSE endpoint that reports the given usage metadata. */
async function collectGeminiUsage(usageMetadata: Record<string, unknown>): Promise<Usage> {
	const sse = `data: ${JSON.stringify({ candidates: [], usageMetadata })}\n\n`;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);

	const model = {
		...getFixtureModel("google-vertex", "gemini-2.5-flash-lite")!,
		provider: "google",
	} as unknown as Model<"google-generative-ai">;
	const result = await streamGoogle(model, context, { apiKey: "test-key" }).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return result.usage;
}

describe("google usage normalization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps totalTokens equal to the sum of components when totalTokenCount is missing", async () => {
		const usage = await collectGeminiUsage({
			promptTokenCount: 20,
			candidatesTokenCount: 8,
			thoughtsTokenCount: 2,
			cachedContentTokenCount: 5,
		});

		expect(usage).toMatchObject({ input: 15, output: 10, cacheRead: 5, cacheWrite: 0 });
		expect(usage.totalTokens).toBe(components(usage));
		expect(usage.totalTokens).toBe(30);
	});

	it("does not produce negative input when cached content tokens exceed prompt tokens", async () => {
		const usage = await collectGeminiUsage({
			promptTokenCount: 10,
			candidatesTokenCount: 5,
			totalTokenCount: 35,
			cachedContentTokenCount: 20,
		});

		expect(usage.input).toBe(0);
		expect(usage.cost.input).toBe(0);
		expect(usage.totalTokens).toBe(components(usage));
	});
});
