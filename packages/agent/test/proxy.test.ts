import { getModels } from "@earendil-works/pi-ai";
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
