import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	payloads: [] as GenerateContentParameters[],
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (params: GenerateContentParameters) {
				googleGenAiMock.payloads.push(params);
				const googleSearchEnabled = params.config?.tools?.some((tool) => "googleSearch" in tool);
				yield {
					candidates: [
						{
							content: { parts: [{ text: "Node.js 24 is the current LTS line." }] },
							finishReason: "STOP",
							...(googleSearchEnabled && {
								groundingMetadata: {
									webSearchQueries: ["current Node.js LTS"],
									groundingChunks: [
										{
											web: {
												title: "Node.js [releases]",
												uri: "https://nodejs.org/en/about/previous-releases",
											},
										},
									],
								},
							}),
						},
					],
					usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 },
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
import { streamGoogleVertex, streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context } from "../src/types.js";

const model = getModel("google-vertex", "gemini-3-flash-preview");
interface CapturedTool {
	functionDeclarations?: Array<Record<string, unknown>>;
	googleSearch?: Record<string, never>;
}

function capturedTools(): CapturedTool[] {
	return (googleGenAiMock.payloads[0]?.config?.tools ?? []) as unknown as CapturedTool[];
}

const context: Context = {
	messages: [{ role: "user", content: "Find the current Node.js LTS line", timestamp: Date.now() }],
	tools: [
		{
			name: "ipython",
			description: "Run local Python code",
			parameters: Type.Object({ code: Type.String() }),
		},
	],
};

const originalGoogleSearch = process.env.GOOGLE_VERTEX_GOOGLE_SEARCH;

beforeEach(() => {
	googleGenAiMock.payloads.length = 0;
	delete process.env.GOOGLE_VERTEX_GOOGLE_SEARCH;
});

afterEach(() => {
	if (originalGoogleSearch === undefined) {
		delete process.env.GOOGLE_VERTEX_GOOGLE_SEARCH;
	} else {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = originalGoogleSearch;
	}
});

describe("Google Vertex native Google Search", () => {
	it("keeps native search disabled by default", async () => {
		const result = await streamSimpleGoogleVertex(model, context, { apiKey: "fake-key", reasoning: "off" }).result();

		expect(capturedTools()).toHaveLength(1);
		expect(capturedTools()[0]?.functionDeclarations).toHaveLength(1);
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).not.toContain(
			"Sources (Google Search)",
		);
	});

	it("combines native search with coding tools and renders grounding sources", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "1";

		const result = await streamSimpleGoogleVertex(model, context, { apiKey: "fake-key", reasoning: "off" }).result();

		expect(capturedTools()).toEqual([
			{
				functionDeclarations: [expect.objectContaining({ name: "ipython", description: "Run local Python code" })],
			},
			{ googleSearch: {} },
		]);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Sources (Google Search):");
		expect(text).toContain("[Node.js \\[releases\\]](https://nodejs.org/en/about/previous-releases)");
		expect(text).toContain("Search queries: current Node.js LTS");
		const groundingBlock = result.content.find(
			(block) => block.type === "text" && block.providerMetadata?.googleSearchGrounding,
		);
		expect(groundingBlock).toMatchObject({
			providerMetadata: {
				googleSearchGrounding: {
					queries: ["current Node.js LTS"],
					sources: [
						{
							title: "Node.js [releases]",
							url: "https://nodejs.org/en/about/previous-releases",
						},
					],
				},
			},
		});
	});

	it("automatically enables native search for a host-routed AVO online-evidence task", async () => {
		await streamSimpleGoogleVertex(
			model,
			{ ...context, systemPrompt: "AVO_ONLINE_EVIDENCE=required" },
			{ apiKey: "fake-key", reasoning: "off" },
		).result();

		expect(capturedTools()).toContainEqual({ googleSearch: {} });
	});

	it("honors an explicit disabled environment setting for benchmark isolation", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "0";

		await streamSimpleGoogleVertex(
			model,
			{ ...context, systemPrompt: "AVO_ONLINE_EVIDENCE=required" },
			{ apiKey: "fake-key", reasoning: "off" },
		).result();

		expect(capturedTools()).toHaveLength(1);
		expect(capturedTools()[0]?.googleSearch).toBeUndefined();
	});

	it("allows a direct provider call to disable an enabled environment default", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "true";

		await streamGoogleVertex(model, context, { apiKey: "fake-key", googleSearch: false }).result();

		expect(capturedTools()).toHaveLength(1);
		expect(capturedTools()[0]?.googleSearch).toBeUndefined();
	});
});
