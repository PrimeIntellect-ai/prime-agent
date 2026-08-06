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
	] as const)("posts native history and returns a validated $type item", async (compactionItem) => {
		const nativeMessage = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "retained" }],
		};
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				model: "gpt-5.1-codex",
				input: [{ role: "user", content: [{ type: "input_text", text: "Keep this history" }] }],
				instructions: "Compact this conversation",
			});

			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${mockToken()}`);
			expect(headers.get("chatgpt-account-id")).toBe("acc_test");
			expect(headers.get("originator")).toBe("pi");
			expect(headers.get("openai-beta")).toBe("responses=experimental");
			expect(headers.get("content-type")).toBe("application/json");
			expect(headers.get("session_id")).toBe("session-1");
			expect(headers.get("x-client-request-id")).toBe("session-1");
			expect(headers.get("user-agent")).toMatch(/^pi \(/);
			expect(headers.get("x-model-header")).toBe("model");
			expect(headers.get("x-option-header")).toBe("option");
			expect(headers.get("accept")).toBeNull();

			return Response.json({
				output: [
					nativeMessage,
					{ type: "reasoning", encrypted_content: "not replacement history" },
					compactionItem,
				],
			});
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
			replacementHistory: [nativeMessage, compactionItem],
			compactionItem,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("prepends compatible provider-native history before new messages", async () => {
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
				input: [...priorHistory, { role: "user", content: [{ type: "input_text", text: "new history" }] }],
			});
			return Response.json({ output: [compactionItem] });
		});
		global.fetch = fetchMock as typeof fetch;

		await compactOpenAICodexResponses(model, replayContext, {
			apiKey: mockToken(),
			instructions: "Compact",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		{ output: undefined },
		{
			output: [
				{ type: "compaction", encrypted_content: "state" },
				{ type: "message", role: "assistant" },
			],
		},
		{ output: [{ type: "compaction" }] },
		{ output: [{ type: "compaction", encrypted_content: "" }] },
		{ output: [{ type: "compaction_summary" }] },
		{ output: [{ type: "compaction_summary", encrypted_content: "" }] },
		{ output: [{ type: "compaction_summary", summary: "wrong-field" }] },
	])("rejects malformed output %#", async (responseBody) => {
		global.fetch = vi.fn(async () => Response.json(responseBody)) as typeof fetch;

		await expect(
			compactOpenAICodexResponses(model, context, {
				apiKey: mockToken(),
				instructions: "Compact",
			}),
		).rejects.toThrow(/compaction response (missing output array|missing final compaction item)/);
	});

	it("aborts a request at the hard request timeout", async () => {
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
	});

	it("forwards caller cancellation to the request", async () => {
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

	it.each([429, 503])("reports HTTP %i without retrying", async (status) => {
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
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("propagates a transient network failure without retrying", async () => {
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
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
