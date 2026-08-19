import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

function testModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "retry-test",
		name: "Retry Test",
		api: "openai-completions",
		provider: "retry-test",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("OpenAI completions retry delay", () => {
	it("returns long Retry-After responses without sleeping", async () => {
		let requests = 0;
		const server = http.createServer((_request, response) => {
			requests++;
			response.writeHead(429, {
				"content-type": "application/json",
				"retry-after": "3600",
			});
			response.end(JSON.stringify({ error: { message: "weekly usage limit reached", type: "rate_limit" } }));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const startedAt = Date.now();
			const events = await collectEvents(
				streamOpenAICompletions(testModel(`http://127.0.0.1:${port}`), context, {
					apiKey: "test-key",
					maxRetries: 2,
					maxRetryDelayMs: 10,
				}),
			);

			expect(Date.now() - startedAt).toBeLessThan(5_000);
			expect(requests).toBe(1);
			const terminal = events.at(-1);
			expect(terminal?.type).toBe("error");
			if (terminal?.type !== "error") throw new Error("expected provider error");
			expect(terminal.error.errorMessage).toContain("Provider requested a 3600000ms retry delay");
			expect(terminal.error.errorMessage).toContain("above the 10ms maximum");
		} finally {
			server.closeAllConnections();
			server.close();
			if (server.listening) await once(server, "close");
		}
	});
});
