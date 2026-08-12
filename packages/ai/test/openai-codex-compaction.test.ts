import { afterEach, describe, expect, it, vi } from "vitest";
import { compactOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { compact } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	headers: { "x-model-header": "model" },
};

const context: Context = {
	systemPrompt: "Normal system prompt is not native compaction instructions.",
	messages: [{ role: "user", content: "Keep this history", timestamp: 1 }],
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function sse(...events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (!signal) {
			reject(new Error("Expected request signal"));
			return;
		}
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("OpenAI Codex provider-native compaction", () => {
	it.each([
		{ type: "compaction", encrypted_content: "encrypted-state" },
		{ type: "compaction_summary", encrypted_content: "compact summary" },
	] as const)("uses V2 SSE and returns a validated terminal $type item", async (compactionItem) => {
		const nativeMessage = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "retained" }],
		};
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				model: "gpt-5.1-codex",
				input: [
					{ role: "user", content: [{ type: "input_text", text: "Keep this history" }] },
					{ type: "compaction_trigger" },
				],
				instructions: "Compact this conversation",
				store: false,
				stream: true,
			});

			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${mockToken()}`);
			expect(headers.get("chatgpt-account-id")).toBe("acc_test");
			expect(headers.get("originator")).toBe("pi");
			expect(headers.get("openai-beta")).toBe("responses=experimental");
			expect(headers.get("content-type")).toBe("application/json");
			expect(headers.get("accept")).toBe("text/event-stream");
			expect(headers.get("session_id")).toBe("session-1");
			expect(headers.get("x-client-request-id")).toBe("session-1");
			expect(headers.get("user-agent")).toMatch(/^pi \(/);
			expect(headers.get("x-model-header")).toBe("model");
			expect(headers.get("x-option-header")).toBe("option");

			return sse(
				{ type: "response.output_item.done", item: nativeMessage },
				{ type: "response.output_item.done", item: { type: "compaction_trigger" } },
				{ type: "response.output_item.done", item: compactionItem },
				{ type: "response.completed", response: { status: "completed" } },
			);
		});
		global.fetch = fetchMock as typeof fetch;

		const result = await compact(model, context, {
			apiKey: mockToken(),
			instructions: "Compact this conversation",
			sessionId: "session-1",
			headers: { "x-option-header": "option" },
		});

		expect(result).toEqual({
			provider: "openai-codex",
			replacementHistory: [
				{ role: "user", content: [{ type: "input_text", text: "Keep this history" }] },
				compactionItem,
			],
			compactionItem,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("stops reading when response.completed arrives", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						[
							{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "state" } },
							{ type: "response.completed", response: { status: "completed" } },
						]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
					),
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		global.fetch = vi.fn(async () => new Response(body)) as typeof fetch;

		await compactOpenAICodexResponses(model, context, { apiKey: mockToken(), instructions: "Compact" });
		expect(cancelled).toBe(true);
	});

	it("truncates an oversized newest user message instead of retaining stale history", async () => {
		const newest = "n".repeat(300_000);
		const oversizedContext: Context = {
			messages: [
				{ role: "user", content: "stale", timestamp: 1 },
				{ role: "user", content: newest, timestamp: 2 },
			],
		};
		const compactionItem = { type: "compaction", encrypted_content: "state" };
		global.fetch = vi.fn(async () =>
			sse(
				{ type: "response.output_item.done", item: compactionItem },
				{ type: "response.completed", response: { status: "completed" } },
			),
		) as typeof fetch;

		const result = await compactOpenAICodexResponses(model, oversizedContext, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		const retained = result.replacementHistory[0] as { content: Array<{ text: string }> };
		expect(result.replacementHistory).toHaveLength(2);
		expect(retained.content[0].text).not.toContain("stale");
		expect(retained.content[0].text.length).toBeGreaterThan(0);
		expect(retained.content[0].text.length).toBeLessThan(newest.length);
		expect(result.replacementHistory[1]).toEqual(compactionItem);
	});

	it("retains a large image while truncating only message text", async () => {
		const imageData = "a".repeat(300_000);
		const newest = "n".repeat(300_000);
		const imageContext: Context = {
			messages: [
				{ role: "user", content: "stale", timestamp: 1 },
				{
					role: "user",
					content: [
						{ type: "text", text: newest },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					timestamp: 2,
				},
			],
		};
		const compactionItem = { type: "compaction", encrypted_content: "state" };
		global.fetch = vi.fn(async () =>
			sse(
				{ type: "response.output_item.done", item: compactionItem },
				{ type: "response.completed", response: { status: "completed" } },
			),
		) as typeof fetch;

		const imageModel: Model<"openai-codex-responses"> = { ...model, input: ["text", "image"] };
		const result = await compactOpenAICodexResponses(imageModel, imageContext, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		const retained = result.replacementHistory[0] as {
			content: Array<{ type: string; text?: string; image_url?: string }>;
		};
		expect(result.replacementHistory).toHaveLength(2);
		expect(retained.content[0].text).not.toContain("stale");
		expect(retained.content[0].text?.length).toBeGreaterThan(0);
		expect(retained.content[0].text?.length).toBeLessThan(newest.length);
		expect(retained.content[1].image_url).toBe(`data:image/png;base64,${imageData}`);
		expect(result.replacementHistory[1]).toEqual(compactionItem);
	});

	it("bounds retained image-only messages", async () => {
		const imageModel: Model<"openai-codex-responses"> = { ...model, input: ["text", "image"] };
		const imageOnlyContext: Context = {
			messages: Array.from({ length: 64_001 }, (_, index) => ({
				role: "user" as const,
				content: [{ type: "image" as const, data: String(index), mimeType: "image/png" }],
				timestamp: index,
			})),
		};
		const compactionItem = { type: "compaction", encrypted_content: "state" };
		global.fetch = vi.fn(async () =>
			sse(
				{ type: "response.output_item.done", item: compactionItem },
				{ type: "response.completed", response: { status: "completed" } },
			),
		) as typeof fetch;

		const result = await compactOpenAICodexResponses(imageModel, imageOnlyContext, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		const first = result.replacementHistory[0] as { content: Array<{ image_url: string }> };
		const last = result.replacementHistory.at(-2) as { content: Array<{ image_url: string }> };
		expect(result.replacementHistory).toHaveLength(64_001);
		expect(first.content[0].image_url).toBe("data:image/png;base64,1");
		expect(last.content[0].image_url).toBe("data:image/png;base64,64000");
	});

	it("falls back to V1 before the V2 request is accepted", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "v1-state" };
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const call = fetchMock.mock.calls.length;
			const headers = new Headers(init?.headers);
			if (call === 1) {
				expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
				expect(JSON.parse(String(init?.body))).toEqual({
					model: "gpt-5.1-codex",
					input: [
						{ role: "user", content: [{ type: "input_text", text: "Keep this history" }] },
						{ type: "compaction_trigger" },
					],
					instructions: "Compact",
					store: false,
					stream: true,
				});
				expect(headers.get("accept")).toBe("text/event-stream");
				return new Response("V2 unavailable", { status: 404 });
			}

			expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
			expect(JSON.parse(String(init?.body))).toEqual({
				model: "gpt-5.1-codex",
				input: [{ role: "user", content: [{ type: "input_text", text: "Keep this history" }] }],
				instructions: "Compact",
			});
			expect(headers.get("accept")).toBeNull();
			return Response.json({ output: [compactionItem] });
		});
		global.fetch = fetchMock as typeof fetch;

		await expect(
			compactOpenAICodexResponses(model, context, { apiKey: mockToken(), instructions: "Compact" }),
		).resolves.toEqual({
			provider: "openai-codex",
			replacementHistory: [compactionItem],
			compactionItem,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("prepends compatible provider-native history before the terminal V2 trigger", async () => {
		const priorHistory = [{ type: "compaction", encrypted_content: "prior-state" }];
		const replayContext: Context = {
			messages: [
				{
					role: "user",
					content: "Provider-native compaction preserved opaque history for this session.",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: priorHistory,
					},
					timestamp: 1,
				},
				{ role: "user", content: "new history", timestamp: 2 },
			],
		};
		const compactionItem = { type: "compaction", encrypted_content: "next-state" };
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({
				input: [
					...priorHistory,
					{ role: "user", content: [{ type: "input_text", text: "new history" }] },
					{ type: "compaction_trigger" },
				],
			});
			return sse(
				{ type: "response.output_item.done", item: compactionItem },
				{ type: "response.completed", response: { status: "completed" } },
			);
		});
		global.fetch = fetchMock as typeof fetch;

		await compactOpenAICodexResponses(model, replayContext, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("falls back when a V2 stream closes before accepting compaction state", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "v1-state" };
		const fetchMock = vi.fn(async () => {
			if (fetchMock.mock.calls.length === 1) {
				return sse({ type: "response.completed", response: { status: "completed" } });
			}
			return Response.json({ output: [compactionItem] });
		});
		global.fetch = fetchMock as typeof fetch;

		await expect(
			compactOpenAICodexResponses(model, context, {
				apiKey: mockToken(),
				instructions: "Compact",
			}),
		).resolves.toMatchObject({ compactionItem });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("aborts a V2 request at the hard request timeout", async () => {
		vi.useFakeTimers();
		global.fetch = vi.fn(async (_input, init) => rejectWhenAborted(init?.signal)) as typeof fetch;

		const request = compactOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			instructions: "Compact",
			timeoutMs: 25,
		});
		const rejection = expect(request).rejects.toThrow("OpenAI Codex compaction request timed out after 25ms");
		await vi.advanceTimersByTimeAsync(25);
		await rejection;
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("forwards caller cancellation to the V2 request", async () => {
		const controller = new AbortController();
		global.fetch = vi.fn(async (_input, init) => rejectWhenAborted(init?.signal)) as typeof fetch;

		const request = compactOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			instructions: "Compact",
			signal: controller.signal,
		});
		controller.abort();

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});

	it.each([429, 503])("falls back once, then reports V1 HTTP %i", async (status) => {
		const fetchMock = vi.fn(async () => new Response("temporarily unavailable", { status }));
		global.fetch = fetchMock as typeof fetch;

		const request = compactOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		await expect(request).rejects.toMatchObject({
			name: "OpenAICodexCompactionHttpError",
			status,
			responseBody: "temporarily unavailable",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back once after a V2 network failure", async () => {
		const failure = new TypeError("connection reset");
		const fetchMock = vi.fn(async () => {
			throw failure;
		});
		global.fetch = fetchMock as typeof fetch;

		await expect(
			compactOpenAICodexResponses(model, context, {
				apiKey: mockToken(),
				instructions: "Compact",
			}),
		).rejects.toBe(failure);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
