import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { CacheRetention, Context, Model, Usage } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface CapturedParams {
	messages: Array<{ role: string; content: string | TextPart[] | null }>;
	tools?: Array<{ type: string; cache_control?: CacheControl }>;
}

const mockState = vi.hoisted(() => ({ lastParams: undefined as CapturedParams | undefined }));

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 100,
									completion_tokens: 10,
									prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
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

function customModel(compat: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return {
		id: "custom-anthropic-proxy",
		name: "Custom Anthropic Proxy",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 4, output: 12, cacheRead: 0.4, cacheWrite: 9 },
		contextWindow: 128000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"openai-completions">,
	options?: { cacheRetention?: CacheRetention },
	messages?: Context["messages"],
): Promise<CapturedParams> {
	await streamOpenAICompletions(
		model,
		{
			systemPrompt: "System prompt",
			messages: messages ?? [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		},
		{ apiKey: "test-key", ...options },
	).result();

	if (!mockState.lastParams) throw new Error("Expected payload to be captured");
	return mockState.lastParams;
}

function instructionMessage(params: CapturedParams) {
	return params.messages.find((message) => message.role === "system" || message.role === "developer");
}

describe("openai-completions cacheControlFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	// Marker placement is the contract: system/instruction block, tool definitions and the final
	// message each carry cache_control, with the ttl only when long retention is actually supported.
	it.each([
		{ name: "model compat opts in", model: () => customModel({ cacheControlFormat: "anthropic" }), ttl: undefined },
		{
			name: "OpenRouter Anthropic route",
			model: () => getFixtureModel<"openai-completions">("openrouter", "anthropic/claude-sonnet-4"),
			ttl: undefined,
		},
		{
			name: "Prime Inference Anthropic route",
			model: () => getModel("prime-inference", "anthropic/claude-fable-5")!,
			ttl: undefined,
		},
		{
			name: "Prime Inference Anthropic route with long retention",
			model: () => getModel("prime-inference", "anthropic/claude-fable-5")!,
			retention: "long" as const,
			ttl: "1h",
		},
		{
			name: "OpenRouter Anthropic route with long retention",
			model: () => getFixtureModel<"openai-completions">("openrouter", "anthropic/claude-sonnet-4"),
			retention: "long" as const,
			ttl: "1h",
		},
		{
			name: "long retention on a model that cannot apply it",
			model: () => customModel({ cacheControlFormat: "anthropic", supportsLongCacheRetention: false }),
			retention: "long" as const,
			ttl: undefined,
		},
	])("marks the instruction block, tools and last message: $name", async ({ model, retention, ttl }) => {
		const expected: CacheControl = ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
		const params = await capturePayload(model(), { cacheRetention: retention });

		const instruction = instructionMessage(params);
		expect(Array.isArray(instruction?.content)).toBe(true);
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual(expected);
		expect(params.tools).toHaveLength(1);
		expect(params.tools?.[0]?.cache_control).toEqual(expected);
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual(expected);
	});

	it.each([
		{
			name: "a non-Anthropic Prime Inference model",
			model: () => getModel("prime-inference", "openai/gpt-5.6-sol")!,
			retention: undefined,
		},
		{
			name: "cacheRetention none",
			model: () => customModel({ cacheControlFormat: "anthropic" }),
			retention: "none" as const,
		},
	])("omits cache markers for $name", async ({ model, retention }) => {
		const params = await capturePayload(model(), { cacheRetention: retention });

		expect(Array.isArray(instructionMessage(params)?.content)).toBe(false);
		expect(params.tools?.[0]?.cache_control).toBeUndefined();
		expect(typeof params.messages[params.messages.length - 1]?.content).toBe("string");
	});

	it("advances the cache marker to the trailing tool result", async () => {
		const model = getModel("prime-inference", "anthropic/claude-haiku-4.5")!;
		const now = Date.now();
		const params = await capturePayload(model, undefined, [
			{ role: "user", content: "Read the file", timestamp: now },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: now + 1,
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: now + 2,
			},
		]);

		expect(params.messages.at(-1)).toMatchObject({
			role: "tool",
			content: [{ type: "text", text: "file contents", cache_control: { type: "ephemeral" } }],
		});
	});
});
