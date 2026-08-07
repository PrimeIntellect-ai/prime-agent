import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model, OpenRouterRouting } from "../src/types.js";

type ResponsesMode = "success" | "unavailable" | "context-overflow" | "auth" | "rate-limit" | "post-start";

interface CapturedChatPayload {
	model?: string;
	session_id?: string;
}

interface CapturedResponsesPayload {
	model?: string;
	input?: unknown[];
	tools?: Array<{ type?: string; name?: string }>;
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	session_id?: string;
	provider?: OpenRouterRouting;
	store?: boolean;
}

const mockState = vi.hoisted(() => ({
	responsesMode: "success" as ResponsesMode,
	chatCalls: [] as CapturedChatPayload[],
	responsesCalls: [] as CapturedResponsesPayload[],
}));

function providerError(status: number, type: string, message: string): Error {
	return Object.assign(new Error(message), {
		status,
		error: { type, message },
	});
}

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedChatPayload) => {
					mockState.chatCalls.push(params);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					return {
						withResponse: async () => ({
							data: stream,
							response: { status: 200, headers: new Headers() },
						}),
					};
				},
			},
		};

		responses = {
			create: (params: CapturedResponsesPayload) => {
				mockState.responsesCalls.push(params);
				return {
					withResponse: async () => {
						switch (mockState.responsesMode) {
							case "unavailable":
								throw providerError(404, "not_found_error", "Responses endpoint is unavailable");
							case "context-overflow":
								throw providerError(400, "context_length_exceeded", "Input exceeds the model context window");
							case "auth":
								throw providerError(401, "authentication_error", "Invalid API key");
							case "rate-limit":
								throw providerError(429, "rate_limit_error", "Rate limit exceeded");
						}

						const mode = mockState.responsesMode;
						const stream = {
							async *[Symbol.asyncIterator]() {
								if (mode === "post-start") {
									throw providerError(500, "server_error", "Responses stream failed");
								}
								yield {
									type: "response.completed",
									response: {
										id: "resp_openrouter",
										status: "completed",
										usage: {
											input_tokens: 4,
											output_tokens: 1,
											total_tokens: 5,
											input_tokens_details: { cached_tokens: 0 },
										},
									},
								};
							},
						};
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					},
				};
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.6-luna",
		name: "OpenAI: GPT-5.6 Luna",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinkingLevelMap: { high: "high" },
		input: ["text"],
		cost: { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		compat: {
			thinkingFormat: "openrouter",
			openRouterRouting: { order: ["openai", "azure"] },
		},
	};
}

const context: Context = {
	systemPrompt: "Use the available tool when asked.",
	messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read one file.",
			parameters: Type.Object({ path: Type.String() }),
		},
	],
};

async function run(options: { openRouterResponses?: boolean } = {}) {
	return streamSimpleOpenAICompletions(createModel(), context, {
		apiKey: "test-key",
		sessionId: "019fd549-abb7-734a-9c7d-d7a2944fab30",
		reasoning: "high",
		...options,
	}).result();
}

describe("OpenRouter Responses transport", () => {
	beforeEach(() => {
		mockState.responsesMode = "success";
		mockState.chatCalls.length = 0;
		mockState.responsesCalls.length = 0;
	});

	it("uses Chat Completions by default", async () => {
		const result = await run();

		expect(result.stopReason).toBe("stop");
		expect(mockState.chatCalls).toHaveLength(1);
		expect(mockState.responsesCalls).toHaveLength(0);
	});

	it("uses stateless Responses with session, cache, routing, tool, and reasoning fields when enabled", async () => {
		const result = await run({ openRouterResponses: true });

		expect(result.stopReason).toBe("stop");
		expect(mockState.chatCalls).toHaveLength(0);
		expect(mockState.responsesCalls).toHaveLength(1);
		expect(mockState.responsesCalls[0]).toMatchObject({
			model: "openai/gpt-5.6-luna",
			prompt_cache_key: "019fd549-abb7-734a-9c7d-d7a2944fab30",
			session_id: "019fd549-abb7-734a-9c7d-d7a2944fab30",
			provider: { order: ["openai", "azure"] },
			store: false,
			reasoning: { effort: "high", summary: "auto" },
			tools: [{ type: "function", name: "read" }],
		});
		expect(mockState.responsesCalls[0].input).toHaveLength(2);
	});

	it("falls back once to Chat when the Responses endpoint is unavailable before start", async () => {
		mockState.responsesMode = "unavailable";

		const result = await run({ openRouterResponses: true });

		expect(result.stopReason).toBe("stop");
		expect(mockState.responsesCalls).toHaveLength(1);
		expect(mockState.chatCalls).toHaveLength(1);
		expect(mockState.chatCalls[0].session_id).toBe("019fd549-abb7-734a-9c7d-d7a2944fab30");
	});

	it.each(["context-overflow", "auth", "rate-limit"] as const)(
		"does not fall back to Chat after a %s failure",
		async (mode) => {
			mockState.responsesMode = mode;

			const result = await run({ openRouterResponses: true });

			expect(result.stopReason).toBe("error");
			expect(mockState.responsesCalls).toHaveLength(1);
			expect(mockState.chatCalls).toHaveLength(0);
		},
	);

	it("does not fall back after the Responses stream starts", async () => {
		mockState.responsesMode = "post-start";

		const result = await run({ openRouterResponses: true });

		expect(result.stopReason).toBe("error");
		expect(mockState.responsesCalls).toHaveLength(1);
		expect(mockState.chatCalls).toHaveLength(0);
	});
});
