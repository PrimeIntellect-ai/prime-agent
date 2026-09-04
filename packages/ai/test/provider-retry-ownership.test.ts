import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function completionsModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

async function streamToError(model: Model<"openai-completions">) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test-key" });
	for await (const event of stream) {
		if (event.type === "error") return event.error;
	}
	throw new Error("expected an error event");
}

describe("provider retry ownership", () => {
	it("makes exactly one request on a 500 and records a structured stream failure", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { type: "server_error", message: "boom" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);
		global.fetch = fetchMock as typeof fetch;

		const output = await streamToError(completionsModel());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(output.stopReason).toBe("error");
		expect(output.diagnostics?.[0]).toMatchObject({
			type: "provider_stream_failure",
			details: { kind: "server_error", status: 500 },
		});
	});

	it("surfaces the server-requested Retry-After delay on rate limits", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "30" },
				}),
		);
		global.fetch = fetchMock as typeof fetch;

		const output = await streamToError(completionsModel());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(output.diagnostics?.[0]).toMatchObject({
			type: "provider_stream_failure",
			details: { kind: "rate_limit", status: 429, retryAfterMs: 30000 },
		});
	});
});
