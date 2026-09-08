import { afterEach, describe, expect, it, vi } from "vitest";
import { compactionMatchesModel, isCompactionCheckpoint } from "../src/compaction.js";
import { getModel, getModelInputLimit } from "../src/models.js";
import { buildCodexCompactedWindow } from "../src/providers/openai-compaction.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import { compactSimple, supportsCompaction } from "../src/stream.js";
import type { Context } from "../src/types.js";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const output = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "Keep this request" }] },
	{ type: "compaction", id: "cmp_test", encrypted_content: "opaque-checkpoint" },
	{
		type: "message",
		role: "assistant",
		phase: "commentary",
		content: [{ type: "output_text", text: "Retained context" }],
	},
];
const context: Context = {
	systemPrompt: "Use the existing tools.",
	messages: [{ role: "user", content: "Remember the project", timestamp: 1 }],
};

function sse(events: Record<string, unknown>[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("Astra server compaction", () => {
	it.each(["openai", "openai-codex"] as const)("compacts and replays the complete %s window", async (provider) => {
		const model = getModel(provider, "gpt-6-astra");
		const usage = {
			input_tokens: 100,
			output_tokens: 20,
			total_tokens: 120,
			input_tokens_details: { cached_tokens: 30 },
		};
		const expectedWindow =
			provider === "openai"
				? output
				: [{ role: "user", content: [{ type: "input_text", text: "Remember the project" }] }, output[1]];
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			provider === "openai"
				? Response.json({ output, usage })
				: sse([
						{ type: "response.output_item.done", item: output[1] },
						{ type: "response.completed", response: { id: "resp_test", status: "completed", usage } },
					]),
		);
		vi.stubGlobal("fetch", fetchMock);
		expect(supportsCompaction(model)).toBe(true);
		const result = await compactSimple(model, context, {
			apiKey: token,
			sessionId: "test-session",
			customInstructions: "Keep paths",
			serviceTier: "priority",
		});
		expect(result?.checkpoint.items).toEqual(expectedWindow);
		expect(result?.usage).toMatchObject({ input: 70, cacheRead: 30, output: 20, totalTokens: 120 });
		expect(result?.usage?.cost.total).toBeGreaterThan(0);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			provider === "openai"
				? "https://api.openai.com/v1/responses/compact"
				: "https://chatgpt.com/backend-api/codex/responses",
		);
		expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
		if (provider === "openai-codex")
			expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("test-account");
		if (provider === "openai-codex")
			expect(JSON.parse(String(init?.body)).input.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "gpt-6-astra",
			instructions: "Use the existing tools.\n\nKeep paths",
			prompt_cache_key: "test-session",
			service_tier: "priority",
		});
		const checkpoint = result!.checkpoint;
		expect(isCompactionCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toBe(true);
		const replay = convertResponsesMessages(
			model,
			{
				messages: [
					{ role: "user", content: "Display marker only", providerContext: checkpoint, timestamp: 2 },
					{ role: "user", content: "Continue", timestamp: 3 },
				],
			},
			new Set([provider]),
		);
		expect(replay.slice(0, expectedWindow.length)).toEqual(expectedWindow);
		expect(replay).toHaveLength(expectedWindow.length + 1);
		expect(JSON.stringify(replay)).not.toContain("Display marker");
		expect(compactionMatchesModel(checkpoint, { ...model, baseUrl: `${model.baseUrl}/` })).toBe(true);
		expect(() =>
			convertResponsesMessages(
				{ ...model, id: "other-model" },
				{ messages: [{ role: "user", content: "marker", providerContext: checkpoint, timestamp: 2 }] },
				new Set([provider]),
			),
		).toThrow(/rebuild context/);
		expect(compactionMatchesModel(checkpoint, { ...model, baseUrl: "https://another.example/v1" })).toBe(false);
	});

	it.each([404, 405, 501])("permits local fallback for unsupported HTTP %s", async (status) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unsupported", { status })));
		expect(await compactSimple(getModel("openai", "gpt-6-astra"), context, { apiKey: token })).toBeUndefined();
	});

	it.each([401, 403, 429, 500])("preserves failures for HTTP %s without echoing response bodies", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response("sensitive provider body", { status, headers: { "retry-after": "2" } })),
		);
		await expect(compactSimple(getModel("openai", "gpt-6-astra"), context, { apiKey: token })).rejects.toMatchObject({
			status,
			retryAfterMs: 2000,
			message: `Server compaction failed (HTTP ${status})`,
		});
	});

	it.each([{}, { output: [] }, { output: [{ type: "compaction", encrypted_content: "" }] }, { output: [null] }])(
		"rejects malformed output %#",
		async (payload) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
			await expect(compactSimple(getModel("openai", "gpt-6-astra"), context, { apiKey: token })).rejects.toThrow(
				/valid encrypted checkpoint/,
			);
		},
	);

	it("honors cancellation even when a response races the abort", async () => {
		const abort = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				abort.abort();
				return Response.json({ output });
			}),
		);
		await expect(
			compactSimple(getModel("openai", "gpt-6-astra"), context, { apiKey: token, signal: abort.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("keeps unrelated providers on their existing compaction path", () => {
		expect(supportsCompaction(getModel("openai", "gpt-5.5"))).toBe(false);
		expect(supportsCompaction({ ...getModel("openai", "gpt-6-astra"), provider: "gateway" })).toBe(false);
	});

	it.each(
		[
			[],
			[{ type: "response.output_item.done", item: output[1] }],
			[{ type: "response.completed", response: { status: "completed" } }],
			[
				{ type: "response.output_item.done", item: output[1] },
				{ type: "response.output_item.done", item: output[1] },
				{ type: "response.completed", response: { status: "completed" } },
			],
			[
				{ type: "response.output_item.done", item: output[1] },
				{ type: "response.incomplete", response: { status: "incomplete" } },
			],
		].map((events) => ({ events })),
	)("rejects incomplete or ambiguous Codex compaction streams %#", async ({ events }) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(events)));
		await expect(compactSimple(getModel("openai-codex", "gpt-6-astra"), context, { apiKey: token })).rejects.toThrow(
			/compaction/,
		);
	});

	it("retains recent user context within the Codex v2 budget without carrying old assistant/tool/checkpoint items", () => {
		const window = buildCodexCompactedWindow(
			[
				{ role: "user", content: "old user request" },
				{ type: "compaction", encrypted_content: "old checkpoint" },
				{ type: "function_call_output", call_id: "call-1", output: "tool result" },
				{ role: "assistant", content: "assistant detail now in checkpoint" },
				{ role: "user", content: [{ type: "input_text", text: `${"x".repeat(300_000)}LATEST` }] },
			],
			output[1],
		);
		expect(window).toHaveLength(2);
		expect(JSON.stringify(window[0])).toContain("LATEST");
		expect(JSON.stringify(window[0]).length).toBeLessThanOrEqual(64_000 * 4);
		expect(window[1]).toEqual(output[1]);
	});

	it("allows bounded local recovery from an over-limit compact request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 })),
		);
		expect(await compactSimple(getModel("openai", "gpt-6-astra"), context, { apiKey: token })).toBeUndefined();
	});

	it("retains complete images without charging their base64 bytes as text tokens", () => {
		const imageMessage = {
			role: "user",
			content: [
				{ type: "input_text", text: "Inspect this image" },
				{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(500_000)}`, detail: "auto" },
			],
		};
		expect(buildCodexCompactedWindow([imageMessage], output[1])).toEqual([imageMessage, output[1]]);
	});

	it("uses the API input ceiling without enlarging the ChatGPT context", () => {
		const api = getModel("openai", "gpt-6-astra");
		expect(api.contextWindow).toBe(1_050_000);
		expect(getModelInputLimit(api)).toBe(922_000);
		expect(getModelInputLimit({ ...api, maxInputTokens: 200_000 })).toBe(200_000);
		expect(getModelInputLimit({ ...api, maxInputTokens: 2_000_000 })).toBe(922_000);
		expect(getModelInputLimit(getModel("openai-codex", "gpt-6-astra"))).toBe(272_000);
	});
});
