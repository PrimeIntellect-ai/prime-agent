import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Api, Model } from "../src/types.js";
import { getOpenRouterHeaders } from "../src/utils/openrouter-headers.js";

const mockState = vi.hoisted(() => ({ headers: [] as Record<string, string>[] }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = { completions: { create: () => this.request() } };
		responses = { create: () => this.request() };

		constructor(options: { defaultHeaders?: Record<string, string> }) {
			mockState.headers.push(options.defaultHeaders ?? {});
		}

		private request() {
			const data = { async *[Symbol.asyncIterator]() {} };
			return {
				withResponse: async () => ({
					data,
					response: { status: 200, headers: new Headers() },
				}),
			};
		}
	}
	return { default: FakeOpenAI };
});

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test/model",
		name: "Test model",
		api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} as Model<T>;
}

async function startRequest(api: "openai-completions" | "openai-responses", headers?: Record<string, string>) {
	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
	const stream =
		api === "openai-completions"
			? streamOpenAICompletions(model("openai-completions"), context, { apiKey: "test", headers })
			: streamOpenAIResponses(model("openai-responses"), context, { apiKey: "test", headers });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

describe("OpenRouter app attribution", () => {
	beforeEach(() => {
		mockState.headers = [];
	});

	it("identifies Prime Agent with the required attribution headers", () => {
		expect(getOpenRouterHeaders()).toEqual({
			"HTTP-Referer": "https://github.com/PrimeIntellect-ai/prime-agent",
			"X-OpenRouter-Title": "Prime Agent",
			"X-OpenRouter-Categories": "cli-agent",
		});
	});

	it.each(["openai-completions", "openai-responses"] as const)(
		"attributes %s requests and lets explicit headers override defaults",
		async (api) => {
			await startRequest(api, { "X-OpenRouter-Title": "Local override" });
			expect(mockState.headers).toHaveLength(1);
			expect(mockState.headers[0]).toMatchObject({
				"HTTP-Referer": "https://github.com/PrimeIntellect-ai/prime-agent",
				"X-OpenRouter-Title": "Local override",
				"X-OpenRouter-Categories": "cli-agent",
			});
		},
	);
});
