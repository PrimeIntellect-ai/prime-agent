import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { getOpenRouterReasoningCapabilities } from "../src/openrouter-reasoning.js";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/providers/cloudflare.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import { complete, streamSimple } from "../src/stream.js";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	Tool,
	ToolResultMessage,
	Usage,
} from "../src/types.js";
import { getZaiTestModel } from "./zai-test-model.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastClientOptions: undefined as unknown,
	chunks: undefined as
		| Array<null | {
				id?: string;
				model?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
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

describe("openai-completions tool_choice", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
		mockState.chunks = undefined;
	});

	it("forwards toolChoice from simple options to payload", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				toolChoice: "required",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("required");
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools?.length ?? 0).toBeGreaterThan(0);
	});

	it("omits strict when compat disables strict mode", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			compat: { supportsStrictMode: false },
		} as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tools?: Array<{ function?: Record<string, unknown> }> };
		const tool = params.tools?.[0]?.function;
		expect(tool).toBeTruthy();
		expect(tool?.strict).toBeUndefined();
		expect("strict" in (tool ?? {})).toBe(false);
	});

	it("keeps normal reasoning_effort for groq models without compat mapping", async () => {
		const model = getModel("groq", "openai/gpt-oss-20b")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("medium");
	});

	it("enables tool_stream for supported z.ai models with tools", async () => {
		const model = getZaiTestModel({ toolStream: true });
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("stores z.ai tool_stream support in model compat metadata", () => {
		expect(getZaiTestModel({ toolStream: true }).compat?.zaiToolStream).toBe(true);
	});

	it("omits tool_stream when model compat disables it", async () => {
		const baseModel = getZaiTestModel();
		const model = {
			...baseModel,
			compat: {
				...baseModel.compat,
				zaiToolStream: false,
			},
		} as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBeUndefined();
	});

	it("respects explicit z.ai tool_stream compat override", async () => {
		const baseModel = getZaiTestModel();
		const model = {
			...baseModel,
			compat: {
				...baseModel.compat,
				zaiToolStream: true,
			},
		} as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("omits tool_stream when no tools are provided", async () => {
		const model = getZaiTestModel({ toolStream: true });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBeUndefined();
	});

	it("maps non-standard provider finish_reason values to stopReason error", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: { content: "partial" }, finish_reason: null }],
			},
			{
				choices: [{ delta: {}, finish_reason: "network_error" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = getZaiTestModel({ toolStream: true });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Provider finish_reason: network_error");
	});

	it("ignores null stream chunks from openai-compatible providers", async () => {
		mockState.chunks = [
			null,
			{
				id: "chatcmpl-test",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.responseId).toBe("chatcmpl-test");
		expect(response.usage.totalTokens).toBe(4);
		expect(response.content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("coalesces tool call deltas by stable index when provider mutates ids mid-stream", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "functions.read:0",
									type: "function",
									function: { name: "read", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-a",
									type: "function",
									function: { name: null, arguments: '{"path":"README' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-b",
									type: "function",
									function: { name: null, arguments: '.md"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Read README.md",
						timestamp: Date.now(),
					},
				],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		const toolCallContentIndexes: number[] = [];
		for await (const event of s) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				toolCallContentIndexes.push(event.contentIndex);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(toolCallContentIndexes).toEqual([0, 0, 0, 0, 0]);
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(toolCall.id).toBe("functions.read:0");
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect(toolCall).not.toHaveProperty("streamIndex");
		expect(toolCall).not.toHaveProperty("partialArgs");
	});

	it("accumulates mixed content, reasoning, and parallel tool call deltas independently", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "answer 1",
							reasoning_content: "think 1",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_initial",
									type: "function",
									function: { name: "read", arguments: '{"path":"README' },
								},
								{
									index: 1,
									id: "tc_grep_initial",
									type: "function",
									function: { name: "grep", arguments: '{"pattern":"TODO' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { name: "list", arguments: '{"path":"packages' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { name: "write", arguments: '{"path":"out' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: " answer 2",
							tool_calls: [
								{
									index: 1,
									id: "tc_grep_changed",
									type: "function",
									function: { arguments: '","path":"src' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { arguments: '.txt","content":"ok"}' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { arguments: '/ai"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "\n",
							reasoning_content: " think 2",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_changed",
									type: "function",
									function: { arguments: '.md"}' },
								},
								{
									index: 1,
									type: "function",
									function: { arguments: '"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 8,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 2 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "grep",
				description: "Search a file",
				parameters: Type.Object({ pattern: Type.String(), path: Type.String() }),
			},
			{
				name: "list",
				description: "List a directory",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			},
		];
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Think, answer, and use tools.",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{ apiKey: "test" },
		);

		const eventTypes: string[] = [];
		const toolEventsByContentIndex = new Map<number, string[]>();
		for await (const event of s) {
			eventTypes.push(event.type);
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				const events = toolEventsByContentIndex.get(event.contentIndex) ?? [];
				events.push(event.type);
				toolEventsByContentIndex.set(event.contentIndex, events);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(eventTypes.filter((type) => type === "text_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "text_delta")).toHaveLength(3);
		expect(eventTypes.filter((type) => type === "text_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_delta")).toHaveLength(2);
		expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "toolcall_start")).toHaveLength(4);
		expect(eventTypes.filter((type) => type === "toolcall_delta")).toHaveLength(9);
		expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(4);
		expect(toolEventsByContentIndex.get(2)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(3)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(4)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(5)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);

		expect(response.content).toHaveLength(6);
		expect(response.content[0]).toEqual({ type: "text", text: "answer 1 answer 2\n" });
		expect(response.content[1]).toEqual({
			type: "thinking",
			thinking: "think 1 think 2",
			thinkingSignature: "reasoning_content",
		});
		const readCall = response.content[2];
		const grepCall = response.content[3];
		const listCall = response.content[4];
		const writeCall = response.content[5];
		expect(readCall.type).toBe("toolCall");
		expect(grepCall.type).toBe("toolCall");
		expect(listCall.type).toBe("toolCall");
		expect(writeCall.type).toBe("toolCall");
		if (
			readCall.type !== "toolCall" ||
			grepCall.type !== "toolCall" ||
			listCall.type !== "toolCall" ||
			writeCall.type !== "toolCall"
		) {
			throw new Error("Expected toolCall content");
		}
		expect(readCall.id).toBe("tc_read_initial");
		expect(readCall.name).toBe("read");
		expect(readCall.arguments).toEqual({ path: "README.md" });
		expect(readCall).not.toHaveProperty("streamIndex");
		expect(readCall).not.toHaveProperty("partialArgs");
		expect(grepCall.id).toBe("tc_grep_initial");
		expect(grepCall.name).toBe("grep");
		expect(grepCall.arguments).toEqual({ pattern: "TODO", path: "src" });
		expect(grepCall).not.toHaveProperty("streamIndex");
		expect(grepCall).not.toHaveProperty("partialArgs");
		expect(listCall.id).toBe("tc_list_no_index");
		expect(listCall.name).toBe("list");
		expect(listCall.arguments).toEqual({ path: "packages/ai" });
		expect(listCall).not.toHaveProperty("streamIndex");
		expect(listCall).not.toHaveProperty("partialArgs");
		expect(writeCall.id).toBe("tc_write_no_index");
		expect(writeCall.name).toBe("write");
		expect(writeCall.arguments).toEqual({ path: "out.txt", content: "ok" });
		expect(writeCall).not.toHaveProperty("streamIndex");
		expect(writeCall).not.toHaveProperty("partialArgs");
	});

	it("round-trips opaque reasoning_details without a matching tool call id", async () => {
		const details = [
			{
				type: "reasoning.summary",
				index: 0,
				format: "unknown",
				summary: "brief plan",
			},
			{
				type: "reasoning.encrypted",
				index: 1,
				format: "unknown",
				id: "rs_not_a_tool_call",
				data: "opaque-continuation",
			},
		];
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-details",
				choices: [{ delta: { reasoning_details: details }, finish_reason: "stop" }],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const first = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Think privately.", timestamp: 1 }],
			},
			{ apiKey: "test" },
		).result();
		const opaque = first.content.find((block) => block.type === "thinking" && block.redacted);
		expect(opaque).toBeDefined();

		mockState.chunks = [
			{
				id: "chatcmpl-after-replay",
				choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
			},
		];
		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Think privately.", timestamp: 1 },
					first,
					{ role: "user", content: "Continue.", timestamp: 2 },
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: Array<Record<string, unknown>> };
		expect(params.messages[1]?.reasoning_details).toEqual(details);
		expect(params.messages[1]?.content).toBe("");
	});

	it("keeps index-less reasoning details after explicitly indexed details", async () => {
		const explicitDetail = {
			type: "reasoning.summary",
			index: 0,
			format: "unknown",
			summary: "brief plan",
		};
		const indexlessDetail = {
			type: "reasoning.encrypted",
			format: "unknown",
			id: "rs_indexless",
			data: "opaque-continuation",
		};
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-index-order",
				choices: [{ delta: { reasoning_details: [explicitDetail, indexlessDetail] }, finish_reason: "stop" }],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const first = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Think privately.", timestamp: 1 }] },
			{ apiKey: "test" },
		).result();

		mockState.chunks = [
			{
				id: "chatcmpl-after-index-replay",
				choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
			},
		];
		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Think privately.", timestamp: 1 },
					first,
					{ role: "user", content: "Continue.", timestamp: 2 },
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: Array<Record<string, unknown>> };
		expect(params.messages[1]?.reasoning_details).toEqual([explicitDetail, indexlessDetail]);
	});

	it("concatenates same-index reasoning detail fragments", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-fragments",
				choices: [
					{
						delta: {
							reasoning_details: [
								{ type: "reasoning.text", index: 0, format: "unknown", text: "first " },
								{ type: "reasoning.summary", index: 1, format: "unknown", summary: "brief " },
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-reasoning-fragments",
				choices: [
					{
						delta: {
							reasoning_details: [
								{ type: "reasoning.text", index: 0, text: "second" },
								{ type: "reasoning.summary", index: 1, summary: "plan" },
							],
						},
						finish_reason: "stop",
					},
				],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const first = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Think privately.", timestamp: 1 }] },
			{ apiKey: "test" },
		).result();

		mockState.chunks = [
			{
				id: "chatcmpl-after-fragment-replay",
				choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
			},
		];
		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Think privately.", timestamp: 1 },
					first,
					{ role: "user", content: "Continue.", timestamp: 2 },
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: Array<Record<string, unknown>> };
		expect(params.messages[1]?.reasoning_details).toEqual([
			{ type: "reasoning.text", index: 0, format: "unknown", text: "first second" },
			{ type: "reasoning.summary", index: 1, format: "unknown", summary: "brief plan" },
		]);
	});

	it("does not double-count reasoning tokens in completion usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-usage",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 33,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 21 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Use reasoning.",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(10);
		expect(response.usage.output).toBe(33);
		expect(response.usage.totalTokens).toBe(43);
	});

	it("preserves prompt_tokens_details.cache_write_tokens from chunk usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(50);
		expect(response.usage.cacheRead).toBe(20);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("preserves prompt_tokens_details.cache_write_tokens from choice usage fallback", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write-choice",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write-choice",
				choices: [
					{
						delta: {},
						finish_reason: "stop",
						usage: {
							prompt_tokens: 100,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
							completion_tokens_details: { reasoning_tokens: 0 },
						},
					},
				],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(50);
		expect(response.usage.cacheRead).toBe(20);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("uses OpenRouter reasoning object instead of reasoning_effort", async () => {
		const baseModel = getModel("openrouter", "deepseek/deepseek-r1")!;
		const model = { ...baseModel, compat: { ...baseModel.compat, supportsReasoningEffort: true } };
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			reasoning?: { effort?: string };
			reasoning_effort?: string;
		};
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("preserves the OpenRouter model default when reasoning is unspecified", async () => {
		const model = getModel("openrouter", "deepseek/deepseek-r1")!;
		let payload: unknown;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		expect((payload as { reasoning?: unknown }).reasoning).toBeUndefined();
	});

	it("distinguishes omitted reasoning from explicit off for Prime effort models", async () => {
		const model = getModel("prime-inference", "moonshotai/kimi-k3")!;
		const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };
		let payload: unknown;

		await streamSimple(model, context, {
			apiKey: "test",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined();

		await streamSimple(model, context, {
			apiKey: "test",
			reasoning: "off",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning_effort?: unknown }).reasoning_effort).toBe("none");
	});

	it("sends no thinking parameter to Prime Inference GLM routes but keeps the z.ai toggle", async () => {
		const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };
		const payloads = new Map<string, Record<string, unknown>>();
		for (const model of [getModel("prime-inference", "z-ai/glm-5.3")!, getModel("zai", "glm-5.3")!]) {
			await streamSimple(model, context, {
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payloads.set(model.id, params as Record<string, unknown>);
				},
			}).result();
		}
		const prime = payloads.get("z-ai/glm-5.3");
		expect(prime?.enable_thinking).toBeUndefined();
		expect(prime?.reasoning_effort).toBeUndefined();
		expect(prime?.reasoning).toBeUndefined();
		expect(payloads.get("glm-5.3")?.enable_thinking).toBe(true);
	});

	it("serializes explicit off only for models that allow disabling reasoning", async () => {
		const baseModel = getModel("openrouter", "deepseek/deepseek-r1")!;
		const effortCompat = { ...baseModel.compat, supportsReasoningEffort: true };
		const optionalModel = { ...baseModel, compat: effortCompat, thinkingLevelMap: { high: "high" } };
		const mandatoryModel = {
			...baseModel,
			compat: effortCompat,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
		};
		let payload: unknown;
		const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };

		await streamSimple(optionalModel, context, {
			apiKey: "test",
			reasoning: "off",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning?: unknown }).reasoning).toEqual({ effort: "none" });

		await streamSimple(mandatoryModel, context, {
			apiKey: "test",
			reasoning: "off",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning?: unknown }).reasoning).toEqual({ effort: "high" });
	});

	it("uses enabled toggles when an OpenRouter model has no effort selector", async () => {
		const baseModel = getModel("openrouter", "deepseek/deepseek-r1")!;
		const model = {
			...baseModel,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
			compat: { ...baseModel.compat, supportsReasoningEffort: false },
		};
		let payload: unknown;
		const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };

		await streamSimple(model, context, {
			apiKey: "test",
			reasoning: "high",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning?: unknown }).reasoning).toEqual({ enabled: true });

		await streamSimple(model, context, {
			apiKey: "test",
			reasoning: "off",
			onPayload: (params: unknown) => {
				payload = params;
			},
		}).result();
		expect((payload as { reasoning?: unknown }).reasoning).toEqual({ enabled: false });
	});
});

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const cloudflareGatewayCompatModel: Model<"openai-completions"> = {
	...getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	id: "workers-ai/@cf/moonshotai/kimi-k2.6",
};

describe("openai-completions tools payload", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
		mockState.chunks = undefined;
	});

	afterEach(() => {
		delete process.env.CLOUDFLARE_ACCOUNT_ID;
		delete process.env.CLOUDFLARE_GATEWAY_ID;
	});

	it.each([
		{ name: "an empty array", tools: [] as Tool[] },
		{ name: "undefined", tools: undefined },
	])("omits the tools field when context.tools is $name", async ({ tools }) => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools },
			{ apiKey: "test" },
		).result();

		expect("tools" in (mockState.lastParams as object)).toBe(false);
	});

	it("still emits tools: [] when the conversation has tool history", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const now = Date.now();

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: now },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "t1", name: "noop", arguments: {} }],
						stopReason: "toolUse",
						usage: emptyUsage,
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						timestamp: now,
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: now,
					},
				],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		expect((mockState.lastParams as { tools?: unknown[] }).tools).toEqual([]);
	});

	it("uses conservative OpenAI-compatible fields for Cloudflare AI Gateway /compat models", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";

		await streamSimple(
			cloudflareGatewayCompatModel,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			reasoning_effort?: string;
			store?: boolean;
		};
		expect(params.messages[0].role).toBe("system");
		expect(params.max_tokens).toBeDefined();
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();

		const clientOptions = mockState.lastClientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat");
		expect(clientOptions.defaultHeaders?.Authorization).toBeNull();
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test");
	});

	it("preserves inline upstream Authorization for Cloudflare AI Gateway BYOK requests", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";

		await streamSimple(
			getModel("cloudflare-ai-gateway", "gpt-5.1")!,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "cf-token", headers: { Authorization: "Bearer upstream-token" } },
		).result();

		const clientOptions = mockState.lastClientOptions as { defaultHeaders?: Record<string, unknown> };
		expect(clientOptions.defaultHeaders?.Authorization).toBe("Bearer upstream-token");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer cf-token");
	});
});

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions responseModel", () => {
	const usage = {
		prompt_tokens: 1,
		completion_tokens: 1,
		prompt_tokens_details: { cached_tokens: 0 },
		completion_tokens_details: { reasoning_tokens: 0 },
	};

	it.each([
		{ name: "a routed model", chunkModel: "anthropic/claude-opus-4.7", expected: "anthropic/claude-opus-4.7" },
		{ name: "the requested model", chunkModel: "openrouter/auto", expected: undefined },
		{ name: "an empty model", chunkModel: "", expected: undefined },
		{ name: "no model", chunkModel: undefined, expected: undefined },
	])("surfaces responseModel when chunks echo $name", async ({ chunkModel, expected }) => {
		mockState.chunks = [
			{ id: "chatcmpl-1", model: chunkModel, choices: [{ delta: { content: "hi" }, finish_reason: null }] },
			{ id: "chatcmpl-1", model: chunkModel, choices: [{ delta: {}, finish_reason: "stop" }], usage },
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBe(expected);
		expect(message.provider).toBe("openrouter");
		expect(message.stopReason).toBe("stop");
	});
});

describe("openai-completions tool-result content", () => {
	const compat: Required<OpenAICompletionsCompat> = {
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
		cacheControlFormat: "anthropic",
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: true,
	};

	function imageModel(): Model<"openai-completions"> {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
	}

	function buildContext(model: Model<"openai-completions">, toolResults: ToolResultMessage[]): Context {
		const now = Date.now();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: toolResults.map((result) => ({
				type: "toolCall" as const,
				id: result.toolCallId,
				name: result.toolName,
				arguments: {},
			})),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		return { messages: [{ role: "user", content: "go", timestamp: now - 1 }, assistant, ...toolResults] };
	}

	function imageResult(toolCallId: string, timestamp: number): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			],
			isError: false,
			timestamp,
		};
	}

	it("batches tool-result images into one trailing user message", () => {
		const model = imageModel();
		const messages = convertMessages(
			model,
			buildContext(model, [imageResult("tool-1", 1), imageResult("tool-2", 2)]),
			compat,
		);

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
		const imageParts = (messages.at(-1)?.content as Array<{ type?: string }>).filter(
			(part) => part?.type === "image_url",
		);
		expect(imageParts.length).toBe(2);
	});

	it("does not emit the image placeholder for empty-text tool results with no image", () => {
		const model = imageModel();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "" }],
			isError: false,
			timestamp: 1,
		};

		const messages = convertMessages(model, buildContext(model, [toolResult]), compat);

		expect(messages.find((message) => message.role === "tool")?.content).toBe("");
	});
});

describe("OpenRouter reasoning metadata", () => {
	function supportedLevels(thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"]) {
		return getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap } as Model<"openai-completions">);
	}

	function metadata(reasoning: Record<string, unknown>, supportsReasoning = true) {
		return { supported_parameters: supportsReasoning ? ["tools", "reasoning"] : ["tools"], reasoning };
	}

	it.each([
		{
			name: "mandatory reasoning with published efforts hides off",
			reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"] },
			supportsReasoningEffort: true,
			levels: ["minimal", "low", "medium", "high", "xhigh"],
		},
		{
			name: "optional reasoning keeps off plus advertised sparse efforts",
			reasoning: { mandatory: false, supported_efforts: ["high", "none"] },
			supportsReasoningEffort: true,
			levels: ["off", "high"],
		},
		{
			name: "null efforts accept every gateway effort (optional)",
			reasoning: { mandatory: false, supported_efforts: null },
			supportsReasoningEffort: true,
			levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
		{
			name: "null efforts accept every gateway effort (mandatory)",
			reasoning: { mandatory: true, supported_efforts: null },
			supportsReasoningEffort: true,
			levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
		},
		{
			name: "no effort selector falls back to a single toggle (optional)",
			reasoning: { mandatory: false },
			supportsReasoningEffort: false,
			levels: ["off", "high"],
		},
		{
			name: "no effort selector falls back to a single toggle (mandatory)",
			reasoning: { mandatory: true },
			supportsReasoningEffort: false,
			levels: ["high"],
		},
		{
			name: "malformed effort lists fall back to an enabled toggle",
			reasoning: { mandatory: false, supported_efforts: ["unexpected", 123] },
			supportsReasoningEffort: false,
			levels: ["off", "high"],
		},
	])("$name", ({ reasoning, supportsReasoningEffort, levels }) => {
		const capabilities = getOpenRouterReasoningCapabilities(metadata(reasoning));

		expect(capabilities?.supportsReasoningEffort).toBe(supportsReasoningEffort);
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(levels);
	});

	it("ignores the over-reported reasoning object when the route lacks the reasoning parameter", () => {
		expect(
			getOpenRouterReasoningCapabilities(metadata({ mandatory: true, supported_efforts: ["high"] }, false)),
		).toBeUndefined();
	});
});
