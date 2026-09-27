import { type GenerateContentParameters, ThinkingLevel } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context, Model, SimpleStreamOptions } from "../src/types.js";

const model: Model<"google-vertex"> = {
	id: "gemma-4-26b-a4b-it",
	name: "Gemma 4 26B (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 8192,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function captureThinkingConfig(reasoning: SimpleStreamOptions["reasoning"]) {
	let params: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogleVertex(model, context, {
		apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		reasoning,
		onPayload: (payload) => {
			params = payload as GenerateContentParameters;
			throw new Error("payload captured");
		},
	});
	await stream.result();
	if (!params) throw new Error("expected onPayload to capture params");
	return params.config?.thinkingConfig;
}

describe("google-vertex gemma-4 thinking config", () => {
	it.each([
		["off", { thinkingLevel: ThinkingLevel.MINIMAL }],
		["low", { includeThoughts: true, thinkingLevel: ThinkingLevel.MINIMAL }],
		["high", { includeThoughts: true, thinkingLevel: ThinkingLevel.HIGH }],
	] as const)("reasoning %s -> %o", async (reasoning, expected) => {
		expect(await captureThinkingConfig(reasoning)).toEqual(expected);
	});
});
