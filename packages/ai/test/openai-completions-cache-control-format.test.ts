import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Model } from "../src/types.js";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface ToolWithCacheControl {
	type: string;
	cache_control?: CacheControl;
}

interface CapturedParams {
	messages: Array<{
		role: string;
		content: string | TextPart[] | null;
	}>;
	tools?: ToolWithCacheControl[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const hasCacheControl = JSON.stringify(params).includes("cache_control");
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 100,
									completion_tokens: 10,
									prompt_tokens_details: {
										cached_tokens: hasCacheControl ? 80 : 0,
										cache_write_tokens: hasCacheControl ? 80 : 0,
									},
									completion_tokens_details: { reasoning_tokens: 0 },
								},
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

async function runCompletion(
	model: Model<"openai-completions">,
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<{ params: CapturedParams; result: AssistantMessage }> {
	const timestamp = Date.now();

	const result = await streamOpenAICompletions(
		model,
		{
			systemPrompt: "System prompt",
			messages: [{ role: "user", content: "Hello", timestamp }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({
						path: Type.String(),
					}),
				},
			],
		},
		{ apiKey: "test-key", ...options },
	).result();

	if (!mockState.lastParams) {
		throw new Error("Expected payload to be captured");
	}

	return { params: mockState.lastParams, result };
}

async function capturePayload(
	model: Model<"openai-completions">,
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<CapturedParams> {
	return (await runCompletion(model, options)).params;
}

function getInstructionMessage(params: CapturedParams) {
	return params.messages.find((message) => message.role === "system" || message.role === "developer");
}

function expectAnthropicCacheMarkers(
	params: CapturedParams,
	expectedCacheControl: CacheControl = { type: "ephemeral" },
): void {
	const instructionMessage = getInstructionMessage(params);
	expect(instructionMessage).toBeDefined();
	expect(Array.isArray(instructionMessage?.content)).toBe(true);
	expect((instructionMessage?.content as TextPart[])[0]?.cache_control).toEqual(expectedCacheControl);

	expect(params.tools).toHaveLength(1);
	expect(params.tools?.[0]?.cache_control).toEqual(expectedCacheControl);

	const lastMessage = params.messages[params.messages.length - 1];
	expect(lastMessage.role).toBe("user");
	expect(Array.isArray(lastMessage.content)).toBe(true);
	expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual(expectedCacheControl);
}

function expectNoAnthropicCacheMarkers(params: CapturedParams): void {
	const instructionMessage = getInstructionMessage(params);
	expect(Array.isArray(instructionMessage?.content)).toBe(false);
	expect(params.tools?.[0]?.cache_control).toBeUndefined();
	expect(typeof params.messages[params.messages.length - 1]?.content).toBe("string");
}

describe("openai-completions cacheControlFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("applies Anthropic-style cache markers when model compat enables them", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 4, output: 12, cacheRead: 0.4, cacheWrite: 9 },
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};

		const { params, result } = await runCompletion(model);
		expectAnthropicCacheMarkers(params);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.cacheWrite) / 1_000_000);
	});

	it("preserves Anthropic-style cache markers for OpenRouter Anthropic models", async () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4");
		const params = await capturePayload(model);
		expectAnthropicCacheMarkers(params);
	});

	it("preserves route-specific cache write pricing for Anthropic models", async () => {
		const model = getModel("openrouter", "anthropic/claude-3-haiku");
		const { params, result } = await runCompletion(model);
		expectAnthropicCacheMarkers(params);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.cacheWrite) / 1_000_000);
	});

	it("applies Anthropic-style cache markers for Prime Inference Anthropic models", async () => {
		const model = getModel("prime-inference", "anthropic/claude-fable-5");
		const { params, result } = await runCompletion(model);
		expectAnthropicCacheMarkers(params);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.input * 1.25) / 1_000_000);
	});

	it("prices one-hour Prime Inference cache writes at twice the input rate", async () => {
		const model = getModel("prime-inference", "anthropic/claude-fable-5");
		const { params, result } = await runCompletion(model, { cacheRetention: "long" });
		expectAnthropicCacheMarkers(params, { type: "ephemeral", ttl: "1h" });
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.input * 2) / 1_000_000);
	});

	it("prices one-hour OpenRouter Anthropic cache writes at twice the input rate", async () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4");
		const { params, result } = await runCompletion(model, { cacheRetention: "long" });
		expectAnthropicCacheMarkers(params, { type: "ephemeral", ttl: "1h" });
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.input * 2) / 1_000_000);
	});

	it("uses five-minute pricing when a model cannot apply long retention", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-anthropic-proxy",
			name: "Custom Anthropic Proxy",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 4, output: 12, cacheRead: 0.4, cacheWrite: 5 },
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
				supportsLongCacheRetention: false,
			},
		};

		const { params, result } = await runCompletion(model, { cacheRetention: "long" });
		expectAnthropicCacheMarkers(params);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80 * model.cost.input * 1.25) / 1_000_000);
	});

	it("does not apply Anthropic-style cache markers to other Prime Inference models", async () => {
		const model = getModel("prime-inference", "openai/gpt-5.6-sol");
		const params = await capturePayload(model);
		expectNoAnthropicCacheMarkers(params);
	});

	it("omits Anthropic-style cache markers when cacheRetention is none", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};
		const params = await capturePayload(model, { cacheRetention: "none" });
		expectNoAnthropicCacheMarkers(params);
	});
});
