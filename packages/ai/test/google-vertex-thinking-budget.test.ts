import { describe, expect, it, mock } from "bun:test";
import type { GenerateContentParameters } from "@google/genai";

// Import the module normally before mocking so we can spread its exports
import * as googleGenAiActual from "@google/genai";

mock.module("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
			},
		};
	}

	return {
		...googleGenAiActual,
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

import { getModel } from "../src/models.js";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const stableFlashLite = getModel("google-vertex", "gemini-2.5-flash-lite");
const flashLiteModels = [stableFlashLite, { ...stableFlashLite, id: "gemini-2.5-flash-lite-preview" }] as const;

async function captureMinimalReasoningPayload(
	model: (typeof flashLiteModels)[number],
): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogleVertex(model, context, {
		apiKey: "fake-key",
		reasoning: "minimal",
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected Vertex payload to be captured");
	}
	return capturedPayload;
}

describe("Google Vertex thinking budget payload", () => {
	for (const model of flashLiteModels) {
		it(`uses the supported minimal budget for ${model.id}`, async () => {
			const payload = await captureMinimalReasoningPayload(model);

			expect(payload.config?.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingBudget: 512,
			});
		});
	}
});
