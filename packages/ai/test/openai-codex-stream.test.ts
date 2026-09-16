import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsFastMode } from "../src/models.js";
import {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import { buildBaseOptions } from "../src/providers/simple-options.js";
import type { Api, AssistantMessage, Context, Model, ToolResultMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function buildSSEPayload({
	status,
	includeDone = false,
}: {
	status: "completed" | "incomplete";
	includeDone?: boolean;
}): string {
	const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";
	const events = [
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
			type: terminalType,
			response: {
				status,
				incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	];

	if (includeDone) {
		events.push("data: [DONE]");
	}

	return `${events.join("\n\n")}\n\n`;
}

describe("openai-codex streaming", () => {
	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
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
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("pi");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find((c) => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	it("completes after response.completed even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed", includeDone: true });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for completed SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("stop");
	});

	it("maps response.incomplete to stopReason length even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "incomplete" });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for incomplete SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("length");
	});

	it("sets session_id/x-client-request-id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
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
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const sessionId = "test-session-123";
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("session_id")).toBe(sessionId);
				expect(headers?.get("x-client-request-id")).toBe(sessionId);

				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.prompt_cache_key).toBe(sessionId);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, sessionId });
		await streamResult.result();
	});

	it("preserves gpt-5.5 xhigh reasoning effort from simple options", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sse = buildSSEPayload({ status: "completed" });
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		let requestedReasoning: unknown;

		global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				requestedReasoning = body?.reasoning;
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamSimpleOpenAICodexResponses(model, context, { apiKey: token, reasoning: "xhigh" }).result();

		expect(requestedReasoning).toEqual({ effort: "xhigh", summary: "auto" });
	});

	it.each(["gpt-5.3-codex", "gpt-5.4", "gpt-5.5"])("clamps %s minimal reasoning effort to low", async (modelId) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
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
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.reasoning).toEqual({ effort: "low", summary: "auto" });

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: modelId,
			name: modelId,
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
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoningEffort: "minimal",
		});
		await streamResult.result();
	});

	it.each([
		// "default" must stay on the wire: absence means "auto" (the project tier).
		["gpt-5.1-codex", "default", 1],
		["gpt-5.1-codex", "flex", 0.5],
		["gpt-5.1-codex", "priority", 2],
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "flex", 0.5],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.6-sol", "priority", 2],
	] as const)(
		"uses the client-sent %s service tier for %s when Codex echoes default",
		async (modelId, serviceTier, multiplier) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
			process.env.PI_CODING_AGENT_DIR = tempDir;
			const token = mockToken();
			const sse = `${[
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
						service_tier: "default",
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sse));
					controller.close();
				},
			});

			global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					const body = JSON.parse(String(init?.body)) as { service_tier?: string };
					expect(body.service_tier).toBe(serviceTier);
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			}) as typeof fetch;

			const model: Model<"openai-codex-responses"> = {
				id: modelId,
				name: modelId === "gpt-5.5" ? "GPT-5.5" : "GPT-5.1 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};

			const context: Context = {
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			};

			const result = await streamOpenAICodexResponses(model, context, { apiKey: token, serviceTier }).result();

			expect(result.usage.cost.input).toBe(1 * multiplier);
			expect(result.usage.cost.output).toBe(2 * multiplier);
			expect(result.usage.cost.total).toBe(3 * multiplier);
		},
	);

	it("does not set session_id/x-client-request-id headers when sessionId is not provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
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
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.has("session_id")).toBe(false);
				expect(headers?.has("x-client-request-id")).toBe(false);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
		await streamResult.result();
	});
	it("forwards auto transport from streamSimple options and uses cached websocket context", async () => {
		const token = mockToken();
		const sentBodies: unknown[] = [];

		global.fetch = vi.fn(async () => new Response("unexpected fetch", { status: 500 })) as typeof fetch;

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data));
				const events = [
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
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "session-auto",
			transport: "auto",
		}).result();

		expect(sentBodies).toHaveLength(1);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-auto")).toMatchObject({
			cachedContextRequests: 1,
			fullContextRequests: 1,
		});
	});

	it("sends only response input deltas in websocket-cached mode", async () => {
		const token = mockToken();
		const sentBodies: unknown[] = [];
		const responses = [
			{ responseId: "resp_1", messageId: "msg_1", text: "Hello" },
			{ responseId: "resp_2", messageId: "msg_2", text: "Done" },
		];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data));
				const response = responses.shift();
				if (!response) throw new Error("unexpected websocket request");
				const events = [
					{ type: "response.created", response: { id: response.responseId } },
					{
						type: "response.output_item.added",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: response.text },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: response.text }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: response.responseId,
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
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();

		expect(sentBodies).toHaveLength(2);
		const firstBody = sentBodies[0] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		const secondBody = sentBodies[1] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		expect(firstBody.store).toBe(false);
		expect(firstBody.previous_response_id).toBeUndefined();
		expect(firstBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }]);
		expect(secondBody.store).toBe(false);
		expect(secondBody.previous_response_id).toBe("resp_1");
		expect(secondBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Now finish" }] }]);
		expect(getOpenAICodexWebSocketDebugStats("session-1")).toMatchObject({
			requests: 2,
			connectionsCreated: 1,
			connectionsReused: 1,
			cachedContextRequests: 2,
			storeTrueRequests: 0,
			fullContextRequests: 1,
			deltaRequests: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
	});

	it("sends full context without a stale previous_response_id after a reconnect and re-anchors", async () => {
		const token = mockToken();
		let firstSocket: ScriptedWebSocketHandle | undefined;
		const sentBodies = installScriptedCodexWebSocket([
			(socket) => {
				firstSocket = socket;
				socket.emit(codexResponseEvents({ responseId: "resp_1", messageId: "msg_1", text: "Hello" }));
			},
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_2", messageId: "msg_2", text: "Done" })),
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_3", messageId: "msg_3", text: "Again" })),
		]);

		const model = codexTestModel();
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-reconnect",
			transport: "websocket-cached",
		}).result();

		// The server dropped the connection during the idle gap between turns.
		firstSocket?.drop();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-reconnect",
			transport: "websocket-cached",
		}).result();

		expect(second.stopReason).toBe("stop");

		const thirdContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...secondContext.messages, second, { role: "user", content: "And again", timestamp: 3 }],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			apiKey: token,
			sessionId: "session-reconnect",
			transport: "websocket-cached",
		}).result();

		expect(sentBodies).toHaveLength(3);
		const reconnectedBody = sentBodies[1] as { previous_response_id?: string; input: unknown[] };
		const resumedBody = sentBodies[2] as { previous_response_id?: string; input: unknown[] };
		// The reconnected connection starts from the full context, never the dead
		// connection's previous_response_id.
		expect(reconnectedBody.previous_response_id).toBeUndefined();
		expect(reconnectedBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello", annotations: [] }],
				status: "completed",
				id: "msg_1",
			},
			{ role: "user", content: [{ type: "input_text", text: "Now finish" }] },
		]);
		// The chain re-anchors on the reconnected connection's response.
		expect(resumedBody.previous_response_id).toBe("resp_2");
		expect(resumedBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "And again" }] }]);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-reconnect")).toMatchObject({
			requests: 3,
			connectionsCreated: 2,
			connectionsReused: 1,
			fullContextRequests: 2,
			deltaRequests: 1,
			lastPreviousResponseId: "resp_2",
		});
	});

	it("recovers a stale previous_response_id with one full-context chain-reset retry", async () => {
		const token = mockToken();
		const sentBodies = installScriptedCodexWebSocket([
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_1", messageId: "msg_1", text: "Hello" })),
			(socket) =>
				socket.emit(
					codexErrorEvents("previous_response_not_found", "Previous response with id 'resp_1' not found"),
				),
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_2", messageId: "msg_2", text: "Done" })),
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_3", messageId: "msg_3", text: "Again" })),
		]);

		const model = codexTestModel();
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-chain-reset",
			transport: "websocket-cached",
		}).result();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-chain-reset",
			transport: "websocket-cached",
		}).result();

		// The stale continuation was recovered within the same turn.
		expect(second.stopReason).toBe("stop");
		expect(second.content[0]).toMatchObject({ type: "text", text: "Done" });

		// A later turn proves the chain resumed from the retried response.
		const thirdContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...secondContext.messages, second, { role: "user", content: "And again", timestamp: 3 }],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			apiKey: token,
			sessionId: "session-chain-reset",
			transport: "websocket-cached",
		}).result();

		expect(sentBodies).toHaveLength(4);
		const deltaBody = sentBodies[1] as { previous_response_id?: string; input: unknown[] };
		const retryBody = sentBodies[2] as { previous_response_id?: string; input: unknown[] };
		const resumedBody = sentBodies[3] as { previous_response_id?: string; input: unknown[] };
		expect(deltaBody.previous_response_id).toBe("resp_1");
		expect(deltaBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Now finish" }] }]);
		// The chain reset resends the full request body without previous_response_id.
		expect(retryBody.previous_response_id).toBeUndefined();
		expect(retryBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello", annotations: [] }],
				status: "completed",
				id: "msg_1",
			},
			{ role: "user", content: [{ type: "input_text", text: "Now finish" }] },
		]);
		expect(resumedBody.previous_response_id).toBe("resp_2");
		expect(resumedBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "And again" }] }]);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-chain-reset")).toMatchObject({
			requests: 4,
			connectionsCreated: 2,
			connectionsReused: 2,
			cachedContextRequests: 4,
			fullContextRequests: 2,
			deltaRequests: 2,
			websocketFailures: 0,
			sseFallbacks: 0,
		});
	});

	it("surfaces the error without further retries when the chain-reset retry fails again", async () => {
		const token = mockToken();
		const sentBodies = installScriptedCodexWebSocket([
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_1", messageId: "msg_1", text: "Hello" })),
			(socket) =>
				socket.emit(
					codexErrorEvents("previous_response_not_found", "Previous response with id 'resp_1' not found"),
				),
			(socket) =>
				socket.emit(
					codexErrorEvents("previous_response_not_found", "Previous response with id 'resp_9' not found"),
				),
		]);

		const model = codexTestModel();
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-chain-reset-fail",
			transport: "websocket-cached",
		}).result();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-chain-reset-fail",
			transport: "websocket-cached",
		}).result();

		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toBe("Codex error: Previous response with id 'resp_9' not found");
		// Exactly one chain-reset retry, then the error surfaces unchanged.
		expect(sentBodies).toHaveLength(3);
		const retryBody = sentBodies[2] as { previous_response_id?: string };
		expect(retryBody.previous_response_id).toBeUndefined();
		expect(global.fetch).not.toHaveBeenCalled();
		expect(failureDetails(second)).toMatchObject({ providerErrorType: "previous_response_not_found" });
	});

	it("does not chain-reset retry other codex api errors", async () => {
		const token = mockToken();
		const sentBodies = installScriptedCodexWebSocket([
			(socket) => socket.emit(codexResponseEvents({ responseId: "resp_1", messageId: "msg_1", text: "Hello" })),
			(socket) => socket.emit(codexErrorEvents("invalid_request", "Invalid request")),
		]);

		const model = codexTestModel();
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-chain-reset-other",
			transport: "websocket-cached",
		}).result();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-chain-reset-other",
			transport: "websocket-cached",
		}).result();

		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toBe("Codex error: Invalid request");
		expect(sentBodies).toHaveLength(2);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	function codexTestModel(): Model<"openai-codex-responses"> {
		return {
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
	}

	/** Stub prompt-cache URLs plus a custom /codex/responses handler; returns the request counter. */
	function stubCodexFetch(respond: () => Response): { responsesRequests: number } {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		const counter = { responsesRequests: 0 };
		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				counter.responsesRequests++;
				return respond();
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		return counter;
	}

	async function runCodexErrorTurn(): Promise<AssistantMessage> {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		return streamOpenAICodexResponses(codexTestModel(), context, { apiKey: mockToken(), transport: "sse" }).result();
	}

	function failureDetails(result: AssistantMessage): { kind?: string; retryAfterMs?: number } | undefined {
		const last = result.diagnostics?.at(-1);
		return last?.type === "provider_stream_failure"
			? (last as { details?: { kind?: string; retryAfterMs?: number } }).details
			: undefined;
	}

	/** Handle the send scripts use to drive a mocked websocket connection. */
	interface ScriptedWebSocketHandle {
		emit: (events: unknown[]) => void;
		/** Simulate the server dropping the connection between turns. */
		drop: () => void;
	}

	/**
	 * Install a scripted WebSocket mock: every websocket send consumes one
	 * script entry (across socket instances, so reconnects stay scripted) and
	 * fetch is stubbed so an unexpected SSE fallback fails fast.
	 */
	function installScriptedCodexWebSocket(
		scripts: Array<(socket: ScriptedWebSocketHandle) => void>,
	): Record<string, unknown>[] {
		const sentBodies: Record<string, unknown>[] = [];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data) as Record<string, unknown>);
				const script = scripts.shift();
				if (!script) throw new Error("unexpected websocket request");
				queueMicrotask(() =>
					script({
						emit: (events: unknown[]) => this.emit(events),
						drop: () => {
							this.readyState = 3;
						},
					}),
				);
			}

			close(): void {
				this.readyState = 3;
			}

			emit(events: unknown[]): void {
				for (const event of events) {
					this.dispatch("message", { data: JSON.stringify(event) });
				}
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		global.fetch = vi.fn(async () => new Response("unexpected fetch", { status: 500 })) as typeof fetch;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		return sentBodies;
	}

	function codexResponseEvents({
		responseId,
		messageId,
		text,
	}: {
		responseId: string;
		messageId: string;
		text: string;
	}): unknown[] {
		return [
			{ type: "response.created", response: { id: responseId } },
			{
				type: "response.output_item.added",
				item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: text },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: messageId,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: responseId,
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
	}

	function codexErrorEvents(code: string, message: string): unknown[] {
		return [{ type: "error", code, message }];
	}

	it("throws a structured failure after a single attempt on HTTP 500", async () => {
		const counter = stubCodexFetch(
			() => new Response(JSON.stringify({ error: { type: "server_error", message: "boom" } }), { status: 500 }),
		);

		const result = await runCodexErrorTurn();

		expect(counter.responsesRequests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("boom");
		expect(failureDetails(result)).toMatchObject({ kind: "server_error", status: 500 });
	});

	it("maps nested streaming usage-limit error payloads to a friendly rate-limit failure", async () => {
		const resetsAt = Math.round(Date.now() / 1000) + 2 * 3600;
		const sse = `data: ${JSON.stringify({
			type: "error",
			status_code: 429,
			error: { type: "usage_limit_reached", message: "Usage limit reached", plan_type: "Plus", resets_at: resetsAt },
		})}\n\n`;
		stubCodexFetch(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));

		const result = await runCodexErrorTurn();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			"You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.",
		);
		const details = failureDetails(result);
		expect(details?.kind).toBe("rate_limit");
		expect(details?.retryAfterMs).toBeGreaterThan(0);
		// resets_at has second granularity, so allow the rounding slack.
		expect(details?.retryAfterMs).toBeLessThanOrEqual(2 * 3600 * 1000 + 1000);
	});

	it("waits for the longer of Retry-After header and usage-limit reset", async () => {
		const resetsAt = Math.round(Date.now() / 1000) + 10;
		stubCodexFetch(
			() =>
				new Response(
					JSON.stringify({
						error: { type: "usage_limit_reached", message: "Usage limit reached", resets_at: resetsAt },
					}),
					{ status: 429, headers: { "retry-after": "60" } },
				),
		);

		const result = await runCodexErrorTurn();

		expect(result.stopReason).toBe("error");
		expect(failureDetails(result)?.retryAfterMs).toBe(60000);
	});
});

describe("openai-responses shared conversions", () => {
	const responsesModel: Model<"openai-responses"> = {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};

	const emptyUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function toolResultContext(toolResult: ToolResultMessage): Context {
		return {
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: toolResult.toolName, arguments: {} }],
					api: "openai-responses",
					provider: "openai",
					model: responsesModel.id,
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: 2,
				} satisfies AssistantMessage,
				toolResult,
			],
		};
	}

	function toolResult(toolName: string, content: ToolResultMessage["content"]): ToolResultMessage {
		return { role: "toolResult", toolCallId: "tool-1", toolName, content, isError: false, timestamp: 3 };
	}

	it("removes partialJson from persisted tool-call blocks at output_item.done", async () => {
		const argumentsJson = '{"path":"README.md","content":"updated"}';
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			const item = { type: "function_call", id: "fc_test", call_id: "call_test", name: "edit" };
			yield { type: "response.output_item.added", item: { ...item, arguments: "" } } as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.delta", delta: '{"path":"README.md"' } as ResponseStreamEvent;
			yield {
				type: "response.function_call_arguments.delta",
				delta: ',"content":"updated"}',
			} as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.done", arguments: argumentsJson } as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				item: { ...item, arguments: argumentsJson },
			} as ResponseStreamEvent;
		}

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: responsesModel.api,
			provider: responsesModel.provider,
			model: responsesModel.id,
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
		};
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(events(), output, stream, responsesModel);

		expect(output.content).toHaveLength(1);
		const persisted = output.content[0];
		if (persisted?.type !== "toolCall") throw new Error("Expected toolCall block");
		expect(persisted.arguments).toEqual({ path: "README.md", content: "updated" });
		expect("partialJson" in persisted).toBe(false);
	});

	it("does not emit the image placeholder for empty-text tool results with no image", () => {
		const messages = convertResponsesMessages(
			responsesModel,
			toolResultContext(toolResult("bash", [{ type: "text", text: "" }])),
			new Set(["openai"]),
		);

		expect(messages.find((message) => message.type === "function_call_output")?.output).toBe("");
	});

	it("still attaches images for tool results that contain an image", () => {
		const messages = convertResponsesMessages(
			responsesModel,
			toolResultContext(toolResult("read", [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }])),
			new Set(["openai"]),
		);

		const output = messages.find((message) => message.type === "function_call_output")?.output;
		expect(Array.isArray(output)).toBe(true);
		expect((output as Array<{ type?: string }>).some((part) => part.type === "input_image")).toBe(true);
	});
});

describe("fast mode", () => {
	function fastModeModel(provider: string, id: string, api: Api): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider,
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}

	it.each([
		{ provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" as Api, supported: true },
		{ provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" as Api, supported: true },
		{ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" as Api, supported: true },
		{ provider: "openai-codex", id: "gpt-5.3-codex", api: "openai-codex-responses" as Api, supported: false },
		{ provider: "openai-codex", id: "gpt-5.4-mini", api: "openai-codex-responses" as Api, supported: false },
		{ provider: "openai", id: "gpt-5.1", api: "openai-responses" as Api, supported: false },
		{ provider: "openai", id: "gpt-5.5", api: "openai-responses" as Api, supported: true },
		{ provider: "github-copilot", id: "gpt-5.5", api: "openai-responses" as Api, supported: false },
	])("gates $provider/$id at $supported", ({ provider, id, api, supported }) => {
		expect(supportsFastMode(fastModeModel(provider, id, api))).toBe(supported);
	});

	it.each(["openai-codex", "openai"])("forwards priority service tier for %s models", (provider) => {
		const api: Api = provider === "openai-codex" ? "openai-codex-responses" : "openai-responses";
		expect(buildBaseOptions(fastModeModel(provider, "gpt-5.5", api), { serviceTier: "priority" }).serviceTier).toBe(
			"priority",
		);
	});
});
