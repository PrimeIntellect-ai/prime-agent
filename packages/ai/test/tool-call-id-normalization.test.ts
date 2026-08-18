import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { completeSimple, getEnvApiKey } from "../src/stream.js";
import type { AssistantMessage, Message, Tool, ToolResultMessage } from "../src/types.js";
import { resolveApiKey } from "./oauth.js";

const copilotToken = await resolveApiKey("github-copilot");
const openrouterKey = getEnvApiKey("openrouter");
const codexToken = await resolveApiKey("openai-codex");

const echoToolSchema = Type.Object({
	message: Type.String({ description: "Message to echo back" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo",
	description: "Echoes the message back",
	parameters: echoToolSchema,
};

describe("Tool Call ID Normalization - Live Handoff", () => {
	it.skipIf(!copilotToken || !openrouterKey)(
		"github-copilot -> openrouter should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.2-codex");
			const openrouterModel = getModel("openrouter", "openai/gpt-5.2-codex");

			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'hello world'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();
			expect(toolCall!.type).toBe("toolCall");

			if (toolCall?.type === "toolCall") {
				expect(toolCall.id).toContain("|");
				console.log(`Tool call ID from github-copilot: ${toolCall.id.slice(0, 80)}...`);
			}

			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
				timestamp: Date.now(),
			};

			const openrouterResponse = await completeSimple(
				openrouterModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			expect(openrouterResponse.stopReason, `OpenRouter error: ${openrouterResponse.errorMessage}`).not.toBe(
				"error",
			);
			expect(openrouterResponse.errorMessage).toBeUndefined();
		},
		60000,
	);

	it.skipIf(!copilotToken || !codexToken)(
		"github-copilot -> openai-codex should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.2-codex");
			const codexModel = getModel("openai-codex", "gpt-5.2-codex");

			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'test message'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();

			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "test message" }],
				isError: false,
				timestamp: Date.now(),
			};

			const codexResponse = await completeSimple(
				codexModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			expect(codexResponse.stopReason, `Codex error: ${codexResponse.errorMessage}`).not.toBe("error");
			expect(codexResponse.errorMessage).toBeUndefined();
		},
		60000,
	);
});

describe("Tool Call ID Normalization - Prefilled Context", () => {
	const FAILING_TOOL_CALL_ID =
		"call_pAYbIr76hXIjncD9UE4eGfnS|t5nnb2qYMFWGSsr13fhCd1CaCu3t3qONEPuOudu4HSVEtA8YJSL6FAZUxvoOoD792VIJWl91g87EdqsCWp9krVsdBysQoDaf9lMCLb8BS4EYi4gQd5kBQBYLlgD71PYwvf+TbMD9J9/5OMD42oxSRj8H+vRf78/l2Xla33LWz4nOgsddBlbvabICRs8GHt5C9PK5keFtzyi3lsyVKNlfduK3iphsZqs4MLv4zyGJnvZo/+QzShyk5xnMSQX/f98+aEoNflEApCdEOXipipgeiNWnpFSHbcwmMkZoJhURNu+JEz3xCh1mrXeYoN5o+trLL3IXJacSsLYXDrYTipZZbJFRPAucgbnjYBC+/ZzJOfkwCs+Gkw7EoZR7ZQgJ8ma+9586n4tT4cI8DEhBSZsWMjrCt8dxKg==";

	function buildPrefilledMessages(): Message[] {
		const userMessage: Message = {
			role: "user",
			content: "Use the echo tool to echo 'hello'",
			timestamp: Date.now() - 2000,
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: FAILING_TOOL_CALL_ID,
					name: "echo",
					arguments: { message: "hello" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.2-codex",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now() - 1500,
		};

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: FAILING_TOOL_CALL_ID,
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};

		const followUpUser: Message = {
			role: "user",
			content: "Say hi",
			timestamp: Date.now(),
		};

		return [userMessage, assistantMessage, toolResult, followUpUser];
	}

	it.skipIf(!openrouterKey)(
		"openrouter should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openrouter", "openai/gpt-5.2-codex");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			expect(response.stopReason, `OpenRouter error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("call_id");
				expect(response.errorMessage).not.toContain("too long");
			}
		},
		30000,
	);

	it.skipIf(!codexToken)(
		"openai-codex should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openai-codex", "gpt-5.2-codex");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			expect(response.stopReason, `Codex error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("id");
				expect(response.errorMessage).not.toContain("additional characters");
			}
		},
		30000,
	);
});
