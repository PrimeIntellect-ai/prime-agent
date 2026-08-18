import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(content: AssistantMessage["content"]): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "repro-provider",
				model: "repro-model",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 2,
			} satisfies AssistantMessage,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions reasoning replay", () => {
	it("replays thinking into the field recorded by thinkingSignature", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.content).toBe("answer");
		expect(assistant.reasoning).toBe("step by step");
	});

	it("keeps unsigned thinking as text when the provider doesn't use a reasoning field", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe("unsigned reasoning\n\nanswer");
	});

	it("uses reasoning_content for unsigned thinking only when the provider requires it", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBe("unsigned reasoning");
		expect(assistant.content).toBe("answer");
	});

	it("writes reasoning_content (not the signature field) when the provider requires it", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBe("step by step");
	});

	it("sanitizes unpaired surrogates in replayed reasoning", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "before\ud800after" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content as string).not.toContain("\ud800");
	});

	it("replays signed thinking alongside a tool call", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "deciding to call a tool", thinkingSignature: "reasoning" },
				{ type: "toolCall", id: "call-1", name: "search", arguments: { q: "x" } },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning).toBe("deciding to call a tool");
		expect(Array.isArray(assistant.tool_calls)).toBe(true);
	});
});
