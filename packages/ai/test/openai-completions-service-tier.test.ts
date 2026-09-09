import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model, ServiceTier } from "../src/types.js";

interface CapturedCompletionsPayload {
	service_tier?: ServiceTier;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	responseServiceTier: undefined as ServiceTier | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-1",
								service_tier: mockState.responseServiceTier,
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 100, completion_tokens: 50 },
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "anthropic/claude-opus-5",
		name: "Claude Opus 5",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
		...overrides,
	};
}

async function run(model: Model<"openai-completions">, serviceTier?: ServiceTier) {
	return await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test-key", serviceTier },
	).result();
}

describe("openai-completions service tier", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.responseServiceTier = undefined;
	});

	it("forwards service_tier for OpenRouter requests", async () => {
		await run(createModel(), "flex");

		expect(mockState.lastParams?.service_tier).toBe("flex");
	});

	it("omits service_tier for providers outside the allowlist", async () => {
		await run(createModel({ provider: "prime-inference", baseUrl: "https://api.pinference.ai/api/v1" }), "flex");

		expect(mockState.lastParams?.service_tier).toBeUndefined();
	});

	it("prices usage by the tier that served the request", async () => {
		mockState.responseServiceTier = "flex";
		const message = await run(createModel(), "flex");

		// 150 catalog-rate tokens at $1/M, halved by the flex multiplier.
		expect(message.usage.cost.total).toBeCloseTo(0.000075, 10);
	});

	it("keeps catalog-rate pricing when no tier is in play", async () => {
		const message = await run(createModel());

		expect(message.usage.cost.total).toBeCloseTo(0.00015, 10);
	});
});
