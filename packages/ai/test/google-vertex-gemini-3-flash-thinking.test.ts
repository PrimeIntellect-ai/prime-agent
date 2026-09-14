import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "response" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
			},
		};
	}

	return {
		...actual,
		GoogleGenAI,
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

import { ThinkingLevel } from "@google/genai";
import { convertMessages, getDisabledThinkingConfig, getGoogleThinkingLevel } from "../src/providers/google-shared.js";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context, Model } from "../src/types.js";

function makeVertexModel(id: string, reasoning = true): Model<"google-vertex"> {
	return {
		id,
		name: id,
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "https://{location}-aiplatform.googleapis.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	};
}

describe("Google Vertex Gemini 3 Flash thinking level", () => {
	it("maps disabled thinking config to LOW for Gemini 3 Flash models", () => {
		const flashModel = makeVertexModel("gemini-3-flash-preview");
		const config = getDisabledThinkingConfig(flashModel);
		expect(config).toEqual({ thinkingLevel: ThinkingLevel.LOW });
	});

	it("maps disabled thinking config to LOW for Gemini 3 Pro models", () => {
		const proModel = makeVertexModel("gemini-3-pro-preview");
		const config = getDisabledThinkingConfig(proModel);
		expect(config).toEqual({ thinkingLevel: ThinkingLevel.LOW });
	});

	it("maps disabled thinking config to MINIMAL for Gemini 3 Flash-Lite models", () => {
		const flashLiteModel = makeVertexModel("gemini-3.1-flash-lite");
		const config = getDisabledThinkingConfig(flashLiteModel);
		expect(config).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
	});

	it("maps disabled thinking config to MINIMAL for Gemma 4 models", () => {
		const gemmaModel = makeVertexModel("gemma-4-it");
		const config = getDisabledThinkingConfig(gemmaModel);
		expect(config).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
	});

	it("maps disabled thinking config to LOW for unknown Gemini 3+ models", () => {
		const unknownGemini3 = makeVertexModel("gemini-3-ultra-preview");
		const config = getDisabledThinkingConfig(unknownGemini3);
		expect(config).toEqual({ thinkingLevel: ThinkingLevel.LOW });
	});

	it("maps disabled thinking config to budget 0 for Gemini 2.x models", () => {
		const gemini2Model = makeVertexModel("gemini-2.5-flash");
		const config = getDisabledThinkingConfig(gemini2Model);
		expect(config).toEqual({ thinkingBudget: 0 });
	});

	it("maps effort levels correctly for Gemini 3 Flash models", () => {
		const flashModel = makeVertexModel("gemini-3-flash-preview");
		expect(getGoogleThinkingLevel("minimal", flashModel)).toBe("LOW");
		expect(getGoogleThinkingLevel("low", flashModel)).toBe("LOW");
		expect(getGoogleThinkingLevel("medium", flashModel)).toBe("MEDIUM");
		expect(getGoogleThinkingLevel("high", flashModel)).toBe("HIGH");
	});

	it("maps effort levels correctly for Gemini 3 Pro models", () => {
		const proModel = makeVertexModel("gemini-3-pro-preview");
		expect(getGoogleThinkingLevel("minimal", proModel)).toBe("LOW");
		expect(getGoogleThinkingLevel("low", proModel)).toBe("LOW");
		expect(getGoogleThinkingLevel("medium", proModel)).toBe("HIGH");
		expect(getGoogleThinkingLevel("high", proModel)).toBe("HIGH");
	});

	it("maps effort levels correctly for Gemini 3 Flash-Lite models", () => {
		const flashLiteModel = makeVertexModel("gemini-3.1-flash-lite");
		expect(getGoogleThinkingLevel("minimal", flashLiteModel)).toBe("MINIMAL");
		expect(getGoogleThinkingLevel("low", flashLiteModel)).toBe("LOW");
		expect(getGoogleThinkingLevel("medium", flashLiteModel)).toBe("MEDIUM");
		expect(getGoogleThinkingLevel("high", flashLiteModel)).toBe("HIGH");
	});

	it("maps effort levels correctly for Gemma 4 models", () => {
		const gemmaModel = makeVertexModel("gemma-4-it");
		expect(getGoogleThinkingLevel("minimal", gemmaModel)).toBe("MINIMAL");
		expect(getGoogleThinkingLevel("low", gemmaModel)).toBe("MINIMAL");
		expect(getGoogleThinkingLevel("medium", gemmaModel)).toBe("HIGH");
		expect(getGoogleThinkingLevel("high", gemmaModel)).toBe("HIGH");
	});

	it("sends LOW thinkingLevel in payload when reasoning is off for Gemini 3 Flash", async () => {
		const flashModel = makeVertexModel("gemini-3-flash-preview");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		let capturedPayload: GenerateContentParameters | undefined;

		const stream = streamSimpleGoogleVertex(flashModel, context, {
			apiKey: "fake-key",
			reasoning: "off",
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return payload;
			},
		});

		await stream.result();

		expect(capturedPayload?.config?.thinkingConfig).toEqual({
			thinkingLevel: ThinkingLevel.LOW,
		});
	});

	it("sends LOW thinkingLevel in payload when reasoning is minimal for Gemini 3 Flash", async () => {
		const flashModel = makeVertexModel("gemini-3-flash-preview");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		let capturedPayload: GenerateContentParameters | undefined;

		const stream = streamSimpleGoogleVertex(flashModel, context, {
			apiKey: "fake-key",
			reasoning: "minimal",
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return payload;
			},
		});

		await stream.result();

		expect(capturedPayload?.config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: ThinkingLevel.LOW,
		});
	});

	it("sends MINIMAL thinkingLevel in payload when reasoning is off for Gemini 3 Flash-Lite", async () => {
		const flashLiteModel = makeVertexModel("gemini-3.1-flash-lite");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		let capturedPayload: GenerateContentParameters | undefined;

		const stream = streamSimpleGoogleVertex(flashLiteModel, context, {
			apiKey: "fake-key",
			reasoning: "off",
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return payload;
			},
		});

		await stream.result();

		expect(capturedPayload?.config?.thinkingConfig).toEqual({
			thinkingLevel: ThinkingLevel.MINIMAL,
		});
	});

	it("sends MINIMAL thinkingLevel in payload when reasoning is minimal for Gemini 3 Flash-Lite", async () => {
		const flashLiteModel = makeVertexModel("gemini-3.1-flash-lite");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		let capturedPayload: GenerateContentParameters | undefined;

		const stream = streamSimpleGoogleVertex(flashLiteModel, context, {
			apiKey: "fake-key",
			reasoning: "minimal",
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return payload;
			},
		});

		await stream.result();

		expect(capturedPayload?.config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: ThinkingLevel.MINIMAL,
		});
	});
});

describe("Google Shared convertMessages — Gemini 3 replay", () => {
	const gemini3Model = makeVertexModel("gemini-3-flash-preview");
	const gemini2Model = makeVertexModel("gemini-2.5-flash");

	it("replays synthetic unsigned assistant turns (e.g. /btw) as model turns without thoughtSignature", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "<side_question>What is 2+2?</side_question>" }],
					timestamp: now,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "google-vertex",
					provider: "google-vertex",
					model: gemini3Model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{
					role: "user",
					content: [{ type: "text", text: "<side_question>What is 3+3?</side_question>" }],
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(gemini3Model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[0].parts?.[0]?.text).toBe("<side_question>What is 2+2?</side_question>");
		expect(contents[1].role).toBe("model");
		expect(contents[1].parts?.[0]?.text).toBe("4");
		expect(contents[1].parts?.[0]?.thoughtSignature).toBeUndefined();
		expect(contents[2].role).toBe("user");
		expect(contents[2].parts?.[0]?.text).toBe("<side_question>What is 3+3?</side_question>");
	});

	it("replays cross-model unsigned assistant turns as model turns without thoughtSignature", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Hello from user",
					timestamp: now,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hello from Claude" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{
					role: "user",
					content: "Follow-up question",
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(gemini3Model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[0].parts?.[0]?.text).toBe("Hello from user");
		expect(contents[1].role).toBe("model");
		expect(contents[1].parts?.[0]?.text).toBe("Hello from Claude");
		expect(contents[1].parts?.[0]?.thoughtSignature).toBeUndefined();
		expect(contents[2].role).toBe("user");
		expect(contents[2].parts?.[0]?.text).toBe("Follow-up question");
	});

	it("preserves native Gemini 3 assistant turn when thoughtSignature is present", () => {
		const now = Date.now();
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Hello",
					timestamp: now,
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Hello with signature",
							textSignature: validSig,
						},
					],
					api: "google-vertex",
					provider: "google-vertex",
					model: gemini3Model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{
					role: "user",
					content: "Follow up",
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(gemini3Model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[1].role).toBe("model");
		expect(contents[1].parts?.[0]?.thoughtSignature).toBe(validSig);
		expect(contents[2].role).toBe("user");
	});

	it("preserves unsigned model turn for Gemini 2.x models", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Hello",
					timestamp: now,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hello without signature" }],
					api: "google-vertex",
					provider: "google-vertex",
					model: gemini2Model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{
					role: "user",
					content: "Follow up",
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(gemini2Model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[1].role).toBe("model");
		expect(contents[1].parts?.[0]?.text).toBe("Hello without signature");
		expect(contents[2].role).toBe("user");
	});

	it("preserves unsigned tool calls in model turns for Gemini 3", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Run a command",
					timestamp: now,
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "bash",
							arguments: { command: "echo test" },
						},
					],
					api: "google-vertex",
					provider: "google-vertex",
					model: gemini3Model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: now,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "test" }],
					isError: false,
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(gemini3Model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[1].role).toBe("model");
		expect(contents[1].parts?.[0]?.functionCall?.name).toBe("bash");
		expect(contents[2].role).toBe("user");
		expect(contents[2].parts?.[0]?.functionResponse?.name).toBe("bash");
	});
});
