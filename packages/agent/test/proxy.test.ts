import { getModels, type ToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

const model = getModels("openai")[0];
const proxyOptions = { authToken: "token", proxyUrl: "http://proxy.test" };

function stubProxyResponse(sse: string): { options: { serviceTier?: string } }[] {
	const sent: { options: { serviceTier?: string } }[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return new Response(sse, { status: 200 });
	});
	return sent;
}

afterEach(() => vi.unstubAllGlobals());

it("settles a truncated proxy stream with an error result", async () => {
	stubProxyResponse('data: {"type":"start"}\n\n');
	const result = await streamProxy(model, { messages: [] }, proxyOptions).result();
	expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("truncated") });
});

it("serializes serviceTier into the proxy request", async () => {
	const sent = stubProxyResponse("");
	await streamProxy(model, { messages: [] }, { ...proxyOptions, serviceTier: "priority" }).result();
	expect(sent[0]?.options.serviceTier).toBe("priority");
});

it.each([
	{ ends: true, stopReason: "toolUse" },
	{ ends: false, stopReason: "error" },
])("finalizes throttled large tool-call arguments (ends cleanly: $ends)", async ({ ends, stopReason }) => {
	const args = JSON.stringify({ content: "x".repeat(20 * 1024) });
	const events: string[] = [
		'{"type":"start"}',
		'{"type":"toolcall_start","contentIndex":0,"id":"call","toolName":"write"}',
	];
	for (let offset = 0; offset < args.length; offset += 16) {
		events.push(JSON.stringify({ type: "toolcall_delta", contentIndex: 0, delta: args.slice(offset, offset + 16) }));
	}
	if (ends) {
		events.push('{"type":"toolcall_end","contentIndex":0}');
		events.push(JSON.stringify({ type: "done", reason: "toolUse", usage: {} }));
	}
	stubProxyResponse(`${events.map((event) => `data: ${event}`).join("\n\n")}\n\n`);
	const result = await streamProxy(model, { messages: [] }, proxyOptions).result();
	const toolCall = result.content[0] as ToolCall;
	expect(result.stopReason).toBe(stopReason);
	expect(toolCall.arguments).toEqual(JSON.parse(args));
	expect(toolCall).not.toHaveProperty("partialJson");
});
