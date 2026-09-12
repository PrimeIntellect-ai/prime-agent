import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context } from "../src/types.js";
import { getXaiSubscriptionModel } from "../src/utils/oauth/xai.js";

const model = getXaiSubscriptionModel(getModel("xai", "grok-4.5"))!;
const reasoning = {
	type: "reasoning",
	id: "rs_grok",
	summary: [],
	content: [{ type: "reasoning_text", text: "Inspect the file." }],
	encrypted_content: "encrypted-reasoning",
	status: "completed",
};
const call = {
	type: "function_call",
	id: "fc_grok",
	call_id: "call_grok",
	name: "ipython",
	arguments: '{"code":"1+1"}',
	status: "completed",
};
const text = {
	type: "message",
	id: "msg_grok",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "2", annotations: [] }],
};
function sse(events: unknown[]): Response {
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}
function terminal(output: unknown[] = [], status = "completed") {
	return {
		type: `response.${status}`,
		response: {
			id: "resp_grok",
			status,
			output,
			usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 5 } },
		},
	};
}
function toolEvents(): Record<string, unknown>[] {
	return [
		{ type: "response.created", response: { id: "resp_grok" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_grok", summary: [] } },
		{ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
		{ type: "response.reasoning_text.delta", output_index: 0, delta: "Inspect the file." },
		{ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"code":' },
		{ type: "response.function_call_arguments.done", output_index: 1, arguments: call.arguments },
		{ type: "response.output_item.done", output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
		{ type: "response.output_item.done", output_index: 1, item: call },
		terminal([reasoning, call]),
	];
}
function textEvents() {
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...text, content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, delta: "2" },
		{ type: "response.output_item.done", output_index: 0, item: text },
		terminal([text]),
	];
}

describe("xAI subscription Responses", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("streams interleaved thinking/tool calls and replays a complete second turn", async () => {
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
				return sse(requests.length === 1 ? toolEvents() : textEvents());
			}),
		);
		const context: Context = {
			systemPrompt: "Use the kernel.",
			messages: [{ role: "user", content: "Calculate 1+1", timestamp: 1 }],
			tools: [{ name: "ipython", description: "Execute Python", parameters: Type.Object({ code: Type.String() }) }],
		};
		const stream = streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-subscription-token",
			reasoning: "medium",
			cacheRetention: "long",
			sessionId: "session-grok",
		});
		const events = [];
		for await (const event of stream) events.push(event);
		const first = await stream.result();
		expect(first.stopReason, first.errorMessage).toBe("toolUse");
		const thinking = first.content.find((block) => block.type === "thinking");
		expect(thinking?.thinking).toBe("Inspect the file.");
		expect(JSON.parse(thinking?.thinkingSignature ?? "{}")).toEqual(reasoning);
		const tool = first.content.find((block) => block.type === "toolCall");
		if (!tool) throw new Error("Missing tool call");
		expect(tool.arguments).toEqual({ code: "1+1" });
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "thinking_delta", contentIndex: 0 }),
				expect.objectContaining({ type: "toolcall_delta", contentIndex: 1 }),
			]),
		);
		context.messages.push(first, {
			role: "toolResult",
			toolCallId: tool.id,
			toolName: tool.name,
			content: [{ type: "text", text: "2" }],
			isError: false,
			timestamp: 2,
		});
		const second = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-subscription-token",
		}).result();
		expect(second.stopReason, second.errorMessage).toBe("stop");
		expect(second.content[0]).toMatchObject({ type: "text", text: "2" });
		expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
		expect(requests[0].headers.get("authorization")).toBe("Bearer test-subscription-token");
		expect(requests[0].body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(requests[0].body).not.toHaveProperty("prompt_cache_retention");
		expect(requests[1].body.include).toEqual(["reasoning.encrypted_content"]);
		const replay = requests[1].body.input as Record<string, unknown>[];
		const replayReasoning = replay.find((item) => item.type === "reasoning");
		expect(replayReasoning).toMatchObject({ id: "rs_grok", encrypted_content: "encrypted-reasoning" });
		expect(replayReasoning).not.toHaveProperty("status");
		const replayCall = replay.find((item) => item.type === "function_call");
		const replayResult = replay.find((item) => item.type === "function_call_output");
		expect(replayCall?.call_id).toBeTruthy();
		expect(replayResult?.call_id).toBe(replayCall?.call_id);
		expect(replayResult?.output).toBe("2");
	});
});
