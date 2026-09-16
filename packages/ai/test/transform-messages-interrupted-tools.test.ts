import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, StopReason, ToolCall, ToolResultMessage } from "../src/types.js";

const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function assistant(stopReason: StopReason, ...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "fixture_tool", arguments: {} })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, text = "completed"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

const user: Message = { role: "user", content: "Run fixture", timestamp: 0 };

describe.each([false, true])("interrupted tool history (cross-provider: %s)", (crossProvider) => {
	function transform(messages: Message[]): Message[] {
		const target = crossProvider ? { ...model, provider: "other-provider" } : model;
		return transformMessages(messages, target, (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_"));
	}

	it.each(["aborted", "error"] as const)("omits results from an %s assistant message", (reason) => {
		const messages = [user, assistant(reason, "call|1"), toolResult("call|1")];
		const original = structuredClone(messages);

		expect(transform(messages)).toEqual([user]);
		expect(messages).toEqual(original);
	});

	it("preserves a completed tool exchange", () => {
		const messages = [user, assistant("toolUse", "call|1"), toolResult("call|1")];
		const expectedId = crossProvider ? "call_1" : "call|1";

		expect(transform(messages)).toEqual([user, assistant("toolUse", expectedId), toolResult(expectedId)]);
	});

	it("omits every result from consecutive interrupted turns", () => {
		const messages = [
			user,
			assistant("aborted", "call|1", "call|2"),
			toolResult("call|2"),
			assistant("error", "call|3"),
			toolResult("call|3"),
			toolResult("call|1"),
		];

		expect(transform(messages)).toEqual([user]);
	});

	it.each(["aborted", "error"] as const)("keeps valid exchanges before and after an %s turn", (reason) => {
		const before = [assistant("toolUse", "before|1"), toolResult("before|1")];
		const retry = [assistant("toolUse", "call|1"), toolResult("call|1", "retry completed")];
		const messages = [
			user,
			...before,
			assistant(reason, "call|1", "call|2"),
			toolResult("call|1", "interrupted result"),
			user,
			...retry,
			toolResult("call|2", "late interrupted result"),
		];

		expect(transform(messages)).toEqual(transform([user, ...before, user, ...retry]));
	});
});

describe("tool-result pairing boundaries", () => {
	it("fills missing results for surviving calls around an interrupted turn", () => {
		const messages = [
			user,
			assistant("toolUse", "before"),
			assistant("aborted", "interrupted"),
			toolResult("interrupted"),
			assistant("toolUse", "after", "missing"),
			toolResult("after"),
		];

		expect(transformMessages(messages, model)).toEqual([
			user,
			assistant("toolUse", "before"),
			{ ...toolResult("before", "No result provided"), isError: true, timestamp: expect.any(Number) },
			assistant("toolUse", "after", "missing"),
			toolResult("after"),
			{ ...toolResult("missing", "No result provided"), isError: true, timestamp: expect.any(Number) },
		]);
	});

	it("omits results without a call in the preceding assistant turn", () => {
		const messages = [
			user,
			toolResult("unknown"),
			assistant("toolUse", "finished"),
			toolResult("finished"),
			user,
			toolResult("finished", "late duplicate"),
		];

		expect(transformMessages(messages, model)).toEqual([
			user,
			assistant("toolUse", "finished"),
			toolResult("finished"),
			user,
		]);
	});
});

describe("cross-model session migration", () => {
	const copilotClaude: Model<"anthropic-messages"> = {
		...model,
		id: "claude-sonnet-4.5",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
	};

	function fromOtherModel(api: AssistantMessage["api"], content: AssistantMessage["content"]): AssistantMessage {
		return { ...assistant("toolUse"), api, provider: "github-copilot", model: "gpt-5", content };
	}

	function migrate(messages: Message[]): Message[] {
		return transformMessages(messages, copilotClaude, (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64));
	}

	it("converts thinking blocks to plain text when the source model differs", () => {
		const result = migrate([
			user,
			fromOtherModel("openai-completions", [
				{ type: "thinking", thinking: "Let me think about this...", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "Hi there!" },
			]),
		]);

		const migrated = result.find((message) => message.role === "assistant") as AssistantMessage;
		expect(migrated.content.filter((block) => block.type === "thinking")).toHaveLength(0);
		expect(migrated.content.filter((block) => block.type === "text").length).toBeGreaterThanOrEqual(2);
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const result = migrate([
			user,
			fromOtherModel("openai-responses", [
				{
					type: "toolCall",
					id: "call_123",
					name: "bash",
					arguments: { command: "ls" },
					thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
				},
			]),
			toolResult("call_123"),
		]);

		const migrated = result.find((message) => message.role === "assistant") as AssistantMessage;
		expect(
			(migrated.content.find((block) => block.type === "toolCall") as ToolCall).thoughtSignature,
		).toBeUndefined();
	});

	it("adds synthetic results for trailing orphaned tool calls across the migration", () => {
		const result = migrate([
			user,
			fromOtherModel("openai-responses", [
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "pwd" } },
			]),
			{ ...toolResult("call_1|fc_1"), toolName: "read" },
		]);

		const synthetic = result.filter((message) => message.role === "toolResult" && message.isError);
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0]).toMatchObject({
			toolCallId: "call_2_fc_2",
			toolName: "bash",
			content: [{ type: "text", text: "No result provided" }],
		});
	});
});
