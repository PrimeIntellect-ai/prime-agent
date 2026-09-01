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
const gemini3Flash = getModel("google-vertex", "gemini-3-flash-preview");

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

async function captureDisabledReasoningPayload(model: typeof gemini3Flash): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogleVertex(model, context, {
		apiKey: "fake-key",
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

	it("keeps minimal as the lowest hidden level when Gemini 3 Flash supports it", async () => {
		const payload = await captureDisabledReasoningPayload(gemini3Flash);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("uses the lowest supported hidden thinking level when Gemini 3 Flash cannot use minimal", async () => {
		const model = {
			...gemini3Flash,
			id: "gemini-3.7-flash",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "LOW",
				medium: "MEDIUM",
				high: "HIGH",
				xhigh: null,
				max: null,
			},
		} as typeof gemini3Flash;

		const payload = await captureDisabledReasoningPayload(model);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});
});
