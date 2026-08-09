import { describe, expect, it, vi } from "vitest";

/**
 * One provider-neutral fixture corpus, run through both Google adapters.
 *
 * Gemini and Vertex speak the same `@google/genai` wire format, so identical
 * chunks must produce identical normalized events. This pins that contract so
 * the shared consumer cannot drift back into two implementations.
 */

const genAiMock = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of genAiMock.chunks) {
					yield chunk;
				}
			},
		};
	}

	return {
		GoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			SAFETY: "SAFETY",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel } from "../src/models.js";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import type { AssistantMessageEvent, Context } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const usageMetadata = {
	promptTokenCount: 30,
	candidatesTokenCount: 7,
	thoughtsTokenCount: 3,
	cachedContentTokenCount: 10,
	totalTokenCount: 40,
};

interface Fixture {
	name: string;
	chunks: unknown[];
	/** Set when the fixture is expected to end in the error path. */
	expectError?: boolean;
}

const FIXTURES: Fixture[] = [
	{
		name: "text only",
		chunks: [
			{ responseId: "r1", candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "lo" }] } }] },
			{ candidates: [{ finishReason: "STOP" }], usageMetadata },
		],
	},
	{
		name: "thinking then text, signature only on the first delta",
		chunks: [
			{
				responseId: "r2",
				candidates: [{ content: { parts: [{ thought: true, text: "ponder", thoughtSignature: "c2ln" }] } }],
			},
			{ candidates: [{ content: { parts: [{ thought: true, text: " more" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "answer" }] } }] },
			{ candidates: [{ finishReason: "STOP" }], usageMetadata },
		],
	},
	{
		name: "tool call closes an open text block",
		chunks: [
			{
				responseId: "r3",
				candidates: [{ content: { parts: [{ text: "calling" }] } }],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { id: "call_1", name: "read", args: { path: "a.ts" } } }],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }], usageMetadata },
		],
	},
	{
		name: "duplicate tool call id is regenerated",
		chunks: [
			{
				responseId: "r4",
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { id: "dup", name: "read", args: { path: "a.ts" } } },
								{ functionCall: { id: "dup", name: "read", args: { path: "b.ts" } } },
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }], usageMetadata },
		],
	},
	{
		name: "tool call carries a thought signature",
		chunks: [
			{
				responseId: "r5",
				candidates: [
					{
						content: {
							parts: [{ functionCall: { id: "call_2", name: "write", args: {} }, thoughtSignature: "c2ln" }],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }], usageMetadata },
		],
	},
	{
		name: "length stop reason",
		chunks: [
			{ responseId: "r6", candidates: [{ content: { parts: [{ text: "truncated" }] } }] },
			{ candidates: [{ finishReason: "MAX_TOKENS" }], usageMetadata },
		],
	},
	{
		name: "safety block maps to the error path",
		chunks: [
			{ responseId: "r7", candidates: [{ content: { parts: [{ text: "partial" }] } }] },
			{ candidates: [{ finishReason: "SAFETY" }], usageMetadata },
		],
		expectError: true,
	},
	{
		name: "malformed function call maps to the error path",
		chunks: [{ responseId: "r8", candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata }],
		expectError: true,
	},
	{
		name: "empty stream",
		chunks: [],
	},
	{
		name: "unterminated text block still emits text_end",
		chunks: [{ responseId: "r9", candidates: [{ content: { parts: [{ text: "no finish reason" }] } }] }],
	},
];

/**
 * Strip the fields that are legitimately adapter-specific or non-deterministic:
 * the API/provider/model identity, wall-clock timestamps, the generated portion
 * of a tool call id (which embeds `Date.now()` and a process-wide counter), and
 * diagnostic stack traces (which name the throwing adapter's own file).
 */
function normalize(events: AssistantMessageEvent[]): unknown {
	return JSON.parse(
		JSON.stringify(events, (key, value) => {
			if (key === "timestamp" || key === "api" || key === "provider" || key === "model") return undefined;
			if (key === "stack") return undefined;
			if (key === "id" && typeof value === "string") {
				// Generated ids look like `<name>_<epoch-ms>_<counter>`.
				return value.replace(/_\d+_\d+$/, "_<generated>");
			}
			return value;
		}),
	);
}

async function collect(
	run: () => { [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> },
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of run()) {
		events.push(event);
	}
	return events;
}

describe("Google stream parity across adapters", () => {
	// Same underlying model on both APIs, so cost/reasoning metadata matches and
	// any difference in the normalized events comes from the adapters themselves.
	const geminiModel = getModel("google", "gemini-2.5-flash");
	const vertexModel = getModel("google-vertex", "gemini-2.5-flash");

	it.each(FIXTURES)("produces equivalent events for: $name", async ({ chunks, expectError }) => {
		genAiMock.chunks = chunks;
		const gemini = await collect(() => streamGoogle(geminiModel, context, { apiKey: "fake-key" }));

		genAiMock.chunks = chunks;
		const vertex = await collect(() =>
			streamGoogleVertex(vertexModel, context, { apiKey: "AIzaSyFakeVertexKey1234567890" }),
		);

		expect(normalize(vertex)).toEqual(normalize(gemini));

		const terminal = gemini[gemini.length - 1];
		expect(terminal?.type).toBe(expectError ? "error" : "done");
	});

	it("reports identical usage and cost on both adapters", async () => {
		genAiMock.chunks = FIXTURES[0]!.chunks;
		const gemini = await streamGoogle(geminiModel, context, { apiKey: "fake-key" }).result();

		genAiMock.chunks = FIXTURES[0]!.chunks;
		const vertex = await streamGoogleVertex(vertexModel, context, {
			apiKey: "AIzaSyFakeVertexKey1234567890",
		}).result();

		// input excludes the cached tokens; output includes thinking tokens.
		expect(gemini.usage).toMatchObject({ input: 20, output: 10, cacheRead: 10, totalTokens: 40 });
		expect(vertex.usage).toEqual(gemini.usage);
	});

	const ABORT_CHUNKS = [
		{ responseId: "abort", candidates: [{ content: { parts: [{ text: "partial" }] } }] },
		{ candidates: [{ finishReason: "STOP" }], usageMetadata },
	];

	it("reports an abort raised after the request starts identically", async () => {
		// Each adapter gets its own controller, aborted at the same point in its own
		// lifecycle: after `buildParams` has run, before the stream is drained.
		genAiMock.chunks = ABORT_CHUNKS;
		const geminiController = new AbortController();
		const geminiStream = streamGoogle(geminiModel, context, {
			apiKey: "fake-key",
			signal: geminiController.signal,
		});
		geminiController.abort();
		const gemini = await geminiStream.result();

		genAiMock.chunks = ABORT_CHUNKS;
		const vertexController = new AbortController();
		const vertexStream = streamGoogleVertex(vertexModel, context, {
			apiKey: "AIzaSyFakeVertexKey1234567890",
			signal: vertexController.signal,
		});
		vertexController.abort();
		const vertex = await vertexStream.result();

		expect(gemini.stopReason).toBe("aborted");
		expect(gemini.errorMessage).toBe("Request was aborted");
		expect(vertex.stopReason).toBe(gemini.stopReason);
		expect(vertex.errorMessage).toBe(gemini.errorMessage);
	});

	it("rejects an already-aborted signal identically", async () => {
		const controller = new AbortController();
		controller.abort();

		genAiMock.chunks = ABORT_CHUNKS;
		const gemini = await streamGoogle(geminiModel, context, {
			apiKey: "fake-key",
			signal: controller.signal,
		}).result();

		genAiMock.chunks = ABORT_CHUNKS;
		const vertex = await streamGoogleVertex(vertexModel, context, {
			apiKey: "AIzaSyFakeVertexKey1234567890",
			signal: controller.signal,
		}).result();

		// Both bail out of `buildGoogleParams` before any request is made.
		expect(gemini.stopReason).toBe("aborted");
		expect(gemini.errorMessage).toBe("Request aborted");
		expect(vertex.stopReason).toBe(gemini.stopReason);
		expect(vertex.errorMessage).toBe(gemini.errorMessage);
	});
});
