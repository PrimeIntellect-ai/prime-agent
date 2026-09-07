import type { Response as OpenAIResponse, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { AssistantMessageEvent, Model } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function response(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
	return {
		id: "resp_terminal",
		object: "response",
		created_at: 1,
		model: model.id,
		status: "completed",
		output: [],
		output_text: "",
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		parallel_tool_calls: true,
		temperature: 1,
		top_p: 1,
		tool_choice: "auto",
		tools: [],
		usage: {
			input_tokens: 120,
			input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
			output_tokens: 16384,
			output_tokens_details: { reasoning_tokens: 16384 },
			total_tokens: 16504,
		},
		...overrides,
	};
}

function terminal(
	type: "response.completed" | "response.incomplete",
	overrides: Partial<OpenAIResponse> = {},
): ResponseStreamEvent {
	return {
		type,
		sequence_number: 10,
		response: response({
			status: type === "response.incomplete" ? "incomplete" : "completed",
			incomplete_details: type === "response.incomplete" ? { reason: "max_output_tokens" } : null,
			...overrides,
		}),
	};
}

function toolEvents(): ResponseStreamEvent[] {
	const item = { type: "function_call" as const, id: "fc_test", call_id: "call_test", name: "read", arguments: "{}" };
	return [
		{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
		{ type: "response.output_item.done", sequence_number: 2, output_index: 0, item },
	];
}

async function run(events: ResponseStreamEvent[], abort = false) {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	const controller = new AbortController();
	const stream = streamOpenAIResponses(
		model,
		{ messages: [{ role: "user", content: "Synthetic test", timestamp: 1 }] },
		{
			apiKey: "test-key",
			maxRetries: 0,
			signal: controller.signal,
			onResponse: () => {
				if (abort) controller.abort();
			},
		},
	);
	const emitted: AssistantMessageEvent[] = [];
	for await (const event of stream) emitted.push(event);
	return { result: await stream.result(), emitted };
}

describe("OpenAI Responses terminal events", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["response.completed", "response.incomplete"] as const)(
		"preserves terminal ID and usage for %s",
		async (type) => {
			const { result, emitted } = await run([terminal(type)]);
			expect(result.responseId).toBe("resp_terminal");
			expect(result.usage).toMatchObject({
				input: 20,
				cacheRead: 100,
				cacheWrite: 0,
				output: 16384,
				totalTokens: 16504,
			});
			expect(result.usage.cost.input).toBeCloseTo(0.00002, 10);
			expect(result.usage.cost.cacheRead).toBeCloseTo(0.00005, 10);
			expect(result.usage.cost.output).toBeCloseTo(0.032768, 10);
			expect(result.stopReason).toBe(type === "response.incomplete" ? "length" : "stop");
			expect(emitted.at(-1)?.type).toBe("done");
		},
	);

	it.each([
		["response.completed", "toolUse"],
		["response.incomplete", "length"],
	] as const)("uses %s as the final authority for tool-call completion", async (type, reason) => {
		const { result } = await run([...toolEvents(), terminal(type)]);
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: {} });
		expect(result.stopReason).toBe(reason);
	});

	it.each(["response.completed", "response.incomplete"] as const)(
		"reports content filtering as an error for %s",
		async (type) => {
			const { result, emitted } = await run([
				...toolEvents(),
				terminal(type, { status: "incomplete", incomplete_details: { reason: "content_filter" } }),
			]);
			expect(result.stopReason).toBe("error");
			expect(result.stopReasonRaw).toBe("content_filter");
			expect(result.usage.totalTokens).toBe(16504);
			expect(result.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						details: expect.objectContaining({ kind: "safety", providerErrorType: "content_filter" }),
					}),
				]),
			);
			expect(emitted.at(-1)?.type).toBe("error");
		},
	);

	it("does not promote an incomplete event without optional status or reason to success", async () => {
		const { result } = await run([
			...toolEvents(),
			terminal("response.incomplete", { status: undefined, incomplete_details: null }),
		]);
		expect(result.stopReason).toBe("length");
	});

	it.each([
		["empty stream", []],
		[
			"response.created only",
			[
				{
					type: "response.created",
					sequence_number: 0,
					response: response({ status: "in_progress", usage: undefined }),
				},
			],
		],
		["finished tool item without response terminal", toolEvents()],
	] satisfies [string, ResponseStreamEvent[]][])("rejects EOF after %s", async (_name, events) => {
		const { result, emitted } = await run(events);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					details: expect.objectContaining({
						kind: "malformed_response",
						providerErrorType: "missing_terminal_event",
					}),
				}),
			]),
		);
		expect(emitted.some((event) => event.type === "done")).toBe(false);
		expect(emitted.at(-1)?.type).toBe("error");
	});

	it("preserves provider failures instead of replacing them with a missing-terminal error", async () => {
		const { result } = await run([
			{
				type: "response.failed",
				sequence_number: 1,
				response: response({ status: "failed", error: { code: "server_error", message: "Synthetic failure" } }),
			},
		]);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					details: expect.objectContaining({ kind: "server_error", providerErrorType: "server_error" }),
				}),
			]),
		);
	});

	it("preserves user cancellation without a provider-failure diagnostic", async () => {
		const { result } = await run([], true);
		expect(result.stopReason).toBe("aborted");
		expect(result.diagnostics).toBeUndefined();
	});

	it.each([
		["content_filter", "incomplete", "error", "error"],
		["max_output_tokens", undefined, "length", "done"],
	] as const)("preserves Codex SSE %s terminal semantics", async (reason, status, stopReason, eventType) => {
		const event = terminal("response.incomplete", { status, incomplete_details: { reason } });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(`data: ${JSON.stringify(event)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
		).toString("base64");
		const stream = streamOpenAICodexResponses(
			{ ...model, api: "openai-codex-responses", provider: "openai-codex", compat: undefined },
			{ messages: [{ role: "user", content: "Synthetic test", timestamp: 1 }] },
			{ apiKey: `test.${payload}.test`, transport: "sse" },
		);
		const emitted: AssistantMessageEvent[] = [];
		for await (const next of stream) emitted.push(next);
		const result = await stream.result();
		expect(result.stopReason).toBe(stopReason);
		expect(result.responseId).toBe("resp_terminal");
		expect(result.usage.totalTokens).toBe(16504);
		expect(result.stopReasonRaw).toBe(reason);
		expect(emitted.at(-1)?.type).toBe(eventType);
		if (eventType === "error") expect(emitted.some((next) => next.type === "done")).toBe(false);
	});
});
