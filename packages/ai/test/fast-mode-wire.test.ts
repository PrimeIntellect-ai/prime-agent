import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

const model: Model<"openai-codex-responses"> = {
	// The wire layer must not restrict service tiers to known model IDs.
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};
const tokenPayload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
).toString("base64");
const token = `aaa.${tokenPayload}.bbb`;
const responseEvents = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				total_tokens: 8,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	},
];

describe("Codex fast-mode wire payload", () => {
	it.each([
		["sse", "priority"],
		["sse", "default"],
		["websocket", "priority"],
		["websocket", "default"],
	] as const)("forwards %s service_tier=%s from simple options", async (transport, serviceTier) => {
		const fetchBodies: unknown[] = [];
		const websocketBodies: unknown[] = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			fetchBodies.push(JSON.parse(String(init?.body)));
			return new Response(responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		globalThis.fetch = fetchMock;

		class MockWebSocket extends EventTarget {
			constructor(_url: string, _options?: unknown) {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}

			send(data: string): void {
				websocketBodies.push(JSON.parse(data));
				queueMicrotask(() => {
					for (const event of responseEvents) {
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
					}
				});
			}

			close(): void {}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000);
		try {
			const result = await streamSimpleOpenAICodexResponses(model, context, {
				apiKey: token,
				transport,
				serviceTier,
				signal: controller.signal,
			}).result();

			// Provider callbacks can swallow assertions. Check captured payloads here.
			const bodies = transport === "sse" ? fetchBodies : websocketBodies;
			expect(bodies).toHaveLength(1);
			// Explicit default disables priority; omitting it would select auto instead.
			expect(bodies[0]).toMatchObject({ model: "gpt-6-astra", service_tier: serviceTier });
			if (transport === "websocket") {
				expect(bodies[0]).toMatchObject({ type: "response.create" });
				expect(fetchMock).not.toHaveBeenCalled();
			} else {
				expect(websocketBodies).toHaveLength(0);
			}
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.content.find((part) => part.type === "text")?.text).toBe("Hello");
		} finally {
			clearTimeout(timeout);
			controller.abort();
		}
	});
});
