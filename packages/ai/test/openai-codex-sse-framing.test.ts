import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

const originalFetch = global.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	vi.restoreAllMocks();
});

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const CONTEXT: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const SSE_EVENTS = [
	`data: ${JSON.stringify({
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	})}`,
	`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
	`data: ${JSON.stringify({
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	})}`,
	`data: ${JSON.stringify({
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
	})}`,
];

function installFetch(bodyChunks: string[], token: string): ReturnType<typeof vi.fn> {
	const encoder = new TextEncoder();
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		if (url === RESPONSES_URL) {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of bodyChunks) {
						controller.enqueue(encoder.encode(chunk));
					}
					controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	});
	global.fetch = fetchMock as unknown as typeof fetch;
	void token;
	return fetchMock;
}

async function collect(token: string): Promise<AssistantMessage> {
	let message: AssistantMessage | undefined;
	for await (const event of streamOpenAICodexResponses(MODEL, CONTEXT, { apiKey: token })) {
		if (event.type === "done") {
			message = event.message;
		}
	}
	if (!message) throw new Error("stream ended without a terminal event");
	return message;
}

function useTempAgentDir(): void {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-framing-"));
}

describe("openai-codex SSE framing", () => {
	it("parses a CRLF-delimited event stream", async () => {
		useTempAgentDir();
		const token = mockToken();
		installFetch([`${SSE_EVENTS.join("\r\n\r\n")}\r\n\r\n`], token);

		const message = await collect(token);

		expect(message.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("parses a CRLF stream split between the CR and the LF of an event boundary", async () => {
		useTempAgentDir();
		const token = mockToken();
		const body = `${SSE_EVENTS.join("\r\n\r\n")}\r\n\r\n`;
		const splitAt = body.indexOf("\r\n\r\n") + 1;
		installFetch([body.slice(0, splitAt), body.slice(splitAt)], token);

		const message = await collect(token);

		expect(message.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("emits the final event when the body does not end with a blank line", async () => {
		useTempAgentDir();
		const token = mockToken();
		installFetch([SSE_EVENTS.join("\n\n")], token);

		const message = await collect(token);

		expect(message.content.find((c) => c.type === "text")?.text).toBe("Hello");
		// response.completed is the event that carries usage and the stop reason.
		expect(message.usage.totalTokens).toBe(8);
	});
});

describe("openai-codex request retries", () => {
	it("does not retry a request the server rejected as invalid", async () => {
		useTempAgentDir();
		const token = mockToken();
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === RESPONSES_URL) {
				return new Response(JSON.stringify({ error: { code: "invalid_request_error", message: "bad model" } }), {
					status: 400,
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let errorMessage: AssistantMessage | undefined;
		for await (const event of streamOpenAICodexResponses(MODEL, CONTEXT, { apiKey: token })) {
			if (event.type === "error") {
				errorMessage = event.error;
			}
		}

		expect(errorMessage?.stopReason).toBe("error");
		// A 400 is not retryable. isRetryableError already says so; the terminal throw
		// must not be swallowed by the transport catch and retried anyway.
		const responseCalls = fetchMock.mock.calls.filter(([input]) => String(input) === RESPONSES_URL);
		expect(responseCalls).toHaveLength(1);
	});
});
