import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
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
	it.each(flashLiteModels)("uses the supported minimal budget for $id", async (model) => {
		const payload = await captureMinimalReasoningPayload(model);

		expect(payload.config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 512,
		});
	});
});
