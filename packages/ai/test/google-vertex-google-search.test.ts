import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	payloads: [] as GenerateContentParameters[],
	customGenerator: undefined as
		| ((params: GenerateContentParameters) => AsyncGenerator<unknown, void, unknown>)
		| undefined,
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (params: GenerateContentParameters) {
				googleGenAiMock.payloads.push(params);
				if (googleGenAiMock.customGenerator) {
					yield* googleGenAiMock.customGenerator(params);
					return;
				}
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
import type { Context, TextContent } from "../src/types.js";

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
const originalPiOffline = process.env.PI_OFFLINE;

beforeEach(() => {
	googleGenAiMock.payloads.length = 0;
	googleGenAiMock.customGenerator = undefined;
	delete process.env.GOOGLE_VERTEX_GOOGLE_SEARCH;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	if (originalGoogleSearch === undefined) {
		delete process.env.GOOGLE_VERTEX_GOOGLE_SEARCH;
	} else {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = originalGoogleSearch;
	}
	if (originalPiOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalPiOffline;
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

	it("disables native search when PI_OFFLINE is set, even if GOOGLE_VERTEX_GOOGLE_SEARCH is enabled", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "1";
		process.env.PI_OFFLINE = "1";

		const result = await streamSimpleGoogleVertex(model, context, { apiKey: "fake-key", reasoning: "off" }).result();

		expect(capturedTools()).toHaveLength(1);
		expect(capturedTools()[0]?.googleSearch).toBeUndefined();
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).not.toContain(
			"Sources (Google Search)",
		);
	});

	it("disables native search when AVO_ONLINE_EVIDENCE=not_required marker is present, even if GOOGLE_VERTEX_GOOGLE_SEARCH is enabled", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "1";

		const result = await streamSimpleGoogleVertex(
			model,
			{ ...context, systemPrompt: "AVO_ONLINE_EVIDENCE=not_required" },
			{ apiKey: "fake-key", reasoning: "off" },
		).result();

		expect(capturedTools()).toHaveLength(1);
		expect(capturedTools()[0]?.googleSearch).toBeUndefined();
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).not.toContain(
			"Sources (Google Search)",
		);
	});

	it("preserves grounding metadata on tool-use responses", async () => {
		process.env.GOOGLE_VERTEX_GOOGLE_SEARCH = "1";
		googleGenAiMock.customGenerator = async function* () {
			yield {
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "ipython",
										args: { code: "import os; print(os.name)" },
									},
								},
							],
						},
						finishReason: "STOP",
						groundingMetadata: {
							webSearchQueries: ["python os documentation"],
							groundingChunks: [
								{
									web: {
										title: "Python OS Module",
										uri: "https://docs.python.org/3/library/os.html",
									},
								},
							],
						},
					},
				],
				usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
			};
		};

		const result = await streamSimpleGoogleVertex(model, context, { apiKey: "fake-key", reasoning: "off" }).result();

		expect(result.stopReason).toBe("toolUse");

		const toolCall = result.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({
			type: "toolCall",
			name: "ipython",
			arguments: { code: "import os; print(os.name)" },
		});

		const groundingBlock = result.content.find(
			(block): block is TextContent =>
				block.type === "text" && Boolean(block.providerMetadata?.googleSearchGrounding),
		);
		expect(groundingBlock).toMatchObject({
			type: "text",
			providerMetadata: {
				googleSearchGrounding: {
					queries: ["python os documentation"],
					sources: [
						{
							title: "Python OS Module",
							url: "https://docs.python.org/3/library/os.html",
						},
					],
				},
			},
		});
		expect(groundingBlock?.text).toContain("Sources (Google Search):");
		expect(groundingBlock?.text).toContain("[Python OS Module](https://docs.python.org/3/library/os.html)");
		expect(groundingBlock?.text).toContain("Search queries: python os documentation");
	});
});
