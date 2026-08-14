import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

/**
 * The provider derives an account id from the API key before it calls fetch, so a
 * placeholder token never reaches the transport. This is the minimum shape that gets past it.
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

/**
 * A 200 whose body opens and then sends nothing, which is the reported production shape:
 * the connection stays established with an empty receive queue and the read never returns.
 */
function silentStreamResponse(onCancel: () => void): Response {
	const body = new ReadableStream<Uint8Array>({
		start() {
			// Deliberately never enqueue and never close.
		},
		cancel() {
			onCancel();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("issue #1232 a silent provider stream terminates instead of hanging", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("ends the stream with a stall error rather than blocking forever", async () => {
		let cancelled = false;
		vi.stubGlobal("fetch", async () =>
			silentStreamResponse(() => {
				cancelled = true;
			}),
		);

		const stream = streamOpenAICodexResponses(model, context, {
			apiKey: TEST_TOKEN,
			transport: "sse",
			streamStallTimeoutMs: 300,
		});

		let errorMessage = "";
		for await (const event of stream) {
			if (event.type === "error") {
				errorMessage = String((event as { error?: { errorMessage?: string } }).error?.errorMessage ?? "");
			}
		}

		expect(errorMessage).toContain("sent no data for");
		// The pending read must be released, or the socket leaks for the process lifetime.
		expect(cancelled).toBe(true);
	});

	it("leaves a silent stream unbounded when the guard is disabled", async () => {
		vi.stubGlobal("fetch", async () => silentStreamResponse(() => {}));

		const stream = streamOpenAICodexResponses(model, context, {
			apiKey: TEST_TOKEN,
			transport: "sse",
			streamStallTimeoutMs: 0,
		});

		let settled = false;
		const drain = (async () => {
			for await (const _event of stream) {
				// drain
			}
			settled = true;
		})();

		await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 700))]);
		expect(settled).toBe(false);
	});
});
