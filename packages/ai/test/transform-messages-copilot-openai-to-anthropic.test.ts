import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../src/types.js";

// Normalize function matching what anthropic.ts uses
function anthropicNormalizeToolCallId(
	id: string,
	_model: Model<"anthropic-messages">,
	_source: AssistantMessage,
): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function makeToolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: text === "Request was aborted",
		timestamp: 2,
	};
}

describe("OpenAI to Anthropic session migration for Copilot Claude", () => {
	it("converts thinking blocks to plain text when source model differs", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this...",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "Hi there!" },
				],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		// Thinking block should be converted to text since models differ
		const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
		const thinkingBlocks = assistantMsg.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(0);
		expect(textBlocks.length).toBeGreaterThanOrEqual(2);
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_123",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
					},
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistantMsg.content.find((b) => b.type === "toolCall") as ToolCall;

		expect(toolCall.thoughtSignature).toBeUndefined();
	});

	it("adds synthetic tool results for trailing orphaned tool calls", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: Date.now() },
			makeAssistantMessage([
				{
					type: "toolCall",
					id: "call_123|fc_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			]),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const lastMessage = result[result.length - 1];

		expect(lastMessage).toMatchObject({
			role: "toolResult",
			toolCallId: "call_123_fc_123",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("adds synthetic results only for trailing tool calls that are still missing results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "pwd" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const syntheticResults = result.filter((message) => message.role === "toolResult" && message.isError);

		expect(syntheticResults).toHaveLength(1);
		expect(syntheticResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_2_fc_2",
			toolName: "bash",
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("hoists a real abort result across an interposed update-restart user message", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
			]),
			{ role: "user", content: "<prime_agent_update_interrupted>", timestamp: 1 },
			makeToolResult("call_1|fc_1", "Request was aborted"),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(result[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_1_fc_1",
			content: [{ type: "text", text: "Request was aborted" }],
		});
		expect(result).not.toContainEqual(
			expect.objectContaining({ role: "toolResult", content: [{ type: "text", text: "No result provided" }] }),
		);
	});

	it("uses real results from both sides of a user boundary in a parallel tool batch", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "one" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "read", arguments: { path: "two" } },
				{ type: "toolCall", id: "call_3|fc_3", name: "read", arguments: { path: "three" } },
			]),
			makeToolResult("call_1|fc_1", "one"),
			{ role: "user", content: "restart", timestamp: 1 },
			makeToolResult("call_2|fc_2", "two"),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const results = result.filter((message): message is ToolResultMessage => message.role === "toolResult");

		expect(result.map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
			"user",
		]);
		expect(results.map((message) => [message.toolCallId, message.content[0]])).toEqual([
			["call_1_fc_1", { type: "text", text: "one" }],
			["call_2_fc_2", { type: "text", text: "two" }],
			["call_3_fc_3", { type: "text", text: "No result provided" }],
		]);
	});

	it("still synthesizes a missing result at a user boundary", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeAssistantMessage([{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} }]),
			{ role: "user", content: "continue", timestamp: 1 },
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(result[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_1_fc_1",
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("drops truly orphaned and duplicate late tool results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeToolResult("orphan", "orphan"),
			makeAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
			makeToolResult("call_1", "real"),
			{ role: "user", content: "continue", timestamp: 1 },
			makeToolResult("call_1", "duplicate"),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(result[1]).toMatchObject({ content: [{ type: "text", text: "real" }] });
	});

	it("leaves a well-formed tool turn in source order", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
			makeToolResult("call_1", "real"),
			{ role: "user", content: "continue", timestamp: 1 },
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(result).toEqual(messages);
	});

	it("is idempotent after repairing a broken tool turn", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
			]),
			{ role: "user", content: "restart", timestamp: 1 },
			makeToolResult("call_1|fc_1", "Request was aborted"),
		];
		const repaired = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(transformMessages(repaired, model, anthropicNormalizeToolCallId)).toEqual(repaired);
	});
});
