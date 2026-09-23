import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key?.toLowerCase() === lowerName)?.[1] ?? null;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

const proxyModel = (compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> =>
	({
		...getFixtureModel<"openai-responses">("openai", "gpt-5.4")!,
		provider: "opencode",
		baseUrl: "https://proxy.example.com/v1",
		...(compat ? { compat } : {}),
	}) as Model<"openai-responses">;

/** Drives one request against a stubbed SSE endpoint and returns the payload plus request headers. */
async function captureRequest(
	model: Model<"openai-responses">,
	options: Parameters<typeof streamOpenAIResponses>[2] = {},
): Promise<{ payload: unknown; sessionId: string | null; clientRequestId: string | null }> {
	const captured = {
		payload: undefined as unknown,
		sessionId: null as string | null,
		clientRequestId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	});

	const stream = streamOpenAIResponses(
		model,
		{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{
			apiKey: "test-key",
			...options,
			onPayload: (payload) => {
				captured.payload = payload;
			},
		},
	);
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

// "none" = the model accepts an explicit off switch; "absent" = the field must not be serialized.
const REASONING_DEFAULTS: Array<{
	provider: "openai" | "github-copilot";
	modelId: string;
	effort: "none" | "absent";
	model: () => Model<"openai-responses">;
}> = [
	{
		provider: "github-copilot",
		modelId: "gpt-5-mini",
		effort: "absent",
		model: () => getModel("github-copilot", "gpt-5-mini")!,
	},
	...(["gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			effort: "none" as const,
			model: () => getFixtureModel<"openai-responses">("openai", modelId)!,
		}),
	),
	...(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			effort: "absent" as const,
			model: () => getFixtureModel<"openai-responses">("openai", modelId)!,
		}),
	),
];

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(REASONING_DEFAULTS)(
		"serializes $effort reasoning effort for $provider $modelId when no reasoning is requested",
		async ({ effort, model }) => {
			const { payload } = await captureRequest(model());

			if (effort === "none") {
				expect(payload).toMatchObject({ reasoning: { effort: "none" } });
			} else {
				expect(payload).not.toMatchObject({ reasoning: expect.anything() });
			}
		},
	);

	it.each([
		{
			name: "official OpenAI Responses requests with a sessionId",
			model: () => getFixtureModel<"openai-responses">("openai", "gpt-5.4")!,
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "proxy Responses requests with a sessionId",
			model: () => proxyModel(),
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "a model that opts out of the session_id header",
			model: () => proxyModel({ sendSessionIdHeader: false }),
			options: { sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: "session-123" },
		},
		{
			name: "explicit header overrides",
			model: () => getFixtureModel<"openai-responses">("openai", "gpt-5.4")!,
			options: {
				sessionId: "session-123",
				headers: { session_id: "override-session", "x-client-request-id": "override-request" },
			},
			expected: { sessionId: "override-session", clientRequestId: "override-request" },
		},
		{
			name: "cacheRetention none",
			model: () => getFixtureModel<"openai-responses">("openai", "gpt-5.4")!,
			options: { cacheRetention: "none" as const, sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: null },
		},
	])("sends cache-affinity headers for $name", async ({ model, options, expected }) => {
		const { sessionId, clientRequestId } = await captureRequest(model(), options);

		expect({ sessionId, clientRequestId }).toEqual(expected);
	});

	it.each([
		["github-copilot" as const, "auto" as const, false],
		["github-copilot" as const, "default" as const, false],
		["openai" as const, "default" as const, true],
	])("scopes service_tier serialization to the provider (%s, %s)", async (provider, serviceTier, expected) => {
		const model = {
			...getFixtureModel<"openai-responses">("openai", "gpt-5.4")!,
			provider,
		} as Model<"openai-responses">;
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`;
		let wireBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", serviceTier },
		).result();

		expect(result.stopReason).toBe("stop");
		// Copilot rejects the FIELD for every value; elsewhere absence means "auto"
		// (the project tier), so an explicit "default" must stay on the wire.
		expect(wireBody && "service_tier" in wireBody).toBe(expected);
		if (expected) {
			expect((wireBody as Record<string, unknown>).service_tier).toBe(serviceTier);
		}
	});
});
