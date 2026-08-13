import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

/**
 * The provider derives an account id from the API key before it ever calls fetch, so a
 * placeholder token fails with "Failed to extract accountId from token" and never reaches
 * the transport. This is the minimum shape that gets past it.
 */
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TEST_TOKEN = [
	b64url({ alg: "none" }),
	b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
	"signature",
].join(".");

const model = {
	id: "gpt-5.6-luna",
	name: "Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_000,
} as Model<"openai-codex-responses">;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

/** Drive a real stream against a stubbed transport and report how many requests it made. */
async function transportAttempts(status: number, body: string): Promise<{ calls: number; errorMessage: string }> {
	let calls = 0;
	vi.stubGlobal("fetch", async () => {
		calls += 1;
		return new Response(body, { status, statusText: String(status) });
	});

	// Force SSE; the websocket path has its own transport and is not what this covers.
	const stream = streamOpenAICodexResponses(model, context, { apiKey: TEST_TOKEN, transport: "sse" });
	let errorMessage = "";
	for await (const event of stream) {
		if (event.type === "error") {
			errorMessage = String((event as { error?: { errorMessage?: string } }).error?.errorMessage ?? "");
		}
	}
	return { calls, errorMessage };
}

describe("issue #1330 codex transport does not retry auth failures", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([401, 403])("issues exactly one request for %i", async (status) => {
		const { calls } = await transportAttempts(status, '{"error":{"message":"Your session has expired"}}');
		expect(calls).toBe(1);
	});

	// The status has to win over the body. Before the fix this retried the full budget
	// because the transient regex matched the message text.
	it("issues one request for a 401 whose body reads like a rate limit", async () => {
		const { calls } = await transportAttempts(401, '{"error":{"message":"rate limit exceeded"}}');
		expect(calls).toBe(1);
	});

	it("still spends the budget on a 500", async () => {
		const { calls } = await transportAttempts(500, '{"error":{"message":"server error"}}');
		expect(calls).toBeGreaterThan(1);
	});

	it("keeps the friendly provider message on the terminal event", async () => {
		const { errorMessage } = await transportAttempts(401, '{"error":{"message":"Your session has expired"}}');
		expect(errorMessage).toContain("Your session has expired");
	});
});
