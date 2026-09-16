import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	retainThoughtSignature,
} from "../src/providers/google-shared.js";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context, Model, Tool } from "../src/types.js";

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

function makeTool(parameters: Record<string, unknown>): Tool {
	return {
		name: "test_tool",
		description: "A test tool",
		parameters: parameters as Tool["parameters"],
	};
}

describe("google-shared convertTools", () => {
	it("strips JSON Schema meta keys from parameters when useParameters=true", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				$id: "urn:bash-tool",
				$comment: "A bash tool for demonstration",
				$defs: {
					commandDef: { type: "string" },
				},
				definitions: {
					legacyDef: { type: "number" },
				},
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
		expect(decl?.parameters).not.toHaveProperty("$schema");
		expect(decl?.parameters).not.toHaveProperty("$id");
		expect(decl?.parameters).not.toHaveProperty("$comment");
		expect(decl?.parameters).not.toHaveProperty("$defs");
		expect(decl?.parameters).not.toHaveProperty("definitions");
	});

	it("recursively strips nested JSON Schema meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					deep: {
						$schema: "http://json-schema.org/draft-07/schema#",
						$id: "urn:nested",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				deep: {
					type: "string",
				},
			},
		});
	});

	it("preserves $ref while stripping meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					refProp: {
						$ref: "#/$defs/someDef",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				refProp: {
					$ref: "#/$defs/someDef",
					type: "string",
				},
			},
		});
	});

	it("does not mutate the original Tool.parameters object", () => {
		const originalParameters = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		};
		const tools = [makeTool(originalParameters)];

		convertTools(tools, true);

		expect(originalParameters).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("preserves $schema in parametersJsonSchema when useParameters=false", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, false);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("handles tools without $schema gracefully", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		});
	});

	it("returns undefined for empty tool list", () => {
		expect(convertTools([])).toBeUndefined();
		expect(convertTools([], true)).toBeUndefined();
	});
});

function makeGoogleModel(
	api: "google-generative-ai" | "google-vertex",
	provider: string,
	id: string,
): Model<"google-generative-ai" | "google-vertex"> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<"google-generative-ai" | "google-vertex">;
}

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("google-shared convertMessages — Gemini 3 tool call signatures", () => {
	function toolCallContext(source: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
		return {
			messages: [
				{ role: "user", content: "Hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "bash",
							arguments: { command: "echo hi" },
							...(thoughtSignature && { thoughtSignature }),
						},
						{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "ls -la" } },
					],
					api: source.api,
					provider: source.provider,
					model: source.id,
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
		} as Context;
	}

	it.each([
		{
			name: "unsigned Google Gen AI tool calls from another model",
			model: makeGoogleModel("google-generative-ai", "google", "gemini-3-pro-preview"),
			sourceId: "other-model",
			signature: undefined,
			expected: [undefined, undefined],
		},
		{
			name: "unsigned Vertex tool calls",
			model: makeGoogleModel("google-vertex", "google-vertex", "gemini-3-pro-preview"),
			sourceId: undefined,
			signature: undefined,
			expected: [undefined, undefined],
		},
		{
			name: "a valid signature from the same provider and model",
			model: makeGoogleModel("google-generative-ai", "google", "gemini-3-pro-preview"),
			sourceId: undefined,
			signature: "AAAAAAAAAAAAAAAAAAAAAA==",
			expected: ["AAAAAAAAAAAAAAAAAAAAAA==", undefined],
		},
		{
			name: "non-Gemini-3 models",
			model: makeGoogleModel("google-generative-ai", "google", "gemini-2.5-flash"),
			sourceId: "other-model",
			signature: undefined,
			expected: [undefined, undefined],
		},
	])("never fakes a thought signature for $name", ({ model, sourceId, signature, expected }) => {
		const source = { api: model.api, provider: model.provider, id: sourceId ?? model.id };
		const contents = convertMessages(model, toolCallContext(source, signature));

		const modelTurn = contents.find((content) => content.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.map((part) => part.thoughtSignature)).toEqual(expected);
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");
	});
});

describe("google-shared image tool result routing", () => {
	function imageToolResultContext(model: Model<"google-generative-ai" | "google-vertex">): Context {
		const toolResult = (toolCallId: string, content: unknown) => ({
			role: "toolResult" as const,
			toolCallId,
			toolName: "read",
			content,
			isError: false,
			timestamp: 3,
		});
		return {
			messages: [
				{ role: "user", content: "read the files", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
						{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "image.png" } },
						{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: 2,
				},
				toolResult("call_a", [{ type: "text", text: "alpha text" }]),
				toolResult("call_img", [{ type: "image", data: "abc", mimeType: "image/png" }]),
				toolResult("call_b", [{ type: "text", text: "beta text" }]),
			],
		} as Context;
	}

	it("keeps a separate synthetic image turn for Gemini 2.x models", () => {
		const model = makeGoogleModel("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, imageToolResultContext(model));

		expect(contents).toHaveLength(5);
		expect(contents[2].parts?.every((part) => part.functionResponse)).toBe(true);
		expect(contents[3].parts?.[1]?.inlineData).toBeTruthy();
		expect(contents[4].parts?.[0]?.functionResponse).toBeTruthy();
	});

	it("nests image tool results for Gemini 3 models", () => {
		const model = makeGoogleModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const contents = convertMessages(model, imageToolResultContext(model));

		expect(contents).toHaveLength(3);
		expect(contents[2].parts).toHaveLength(3);
		const imageResponse = contents[2].parts?.[1]?.functionResponse;
		expect(imageResponse?.parts).toHaveLength(1);
		expect(imageResponse?.parts?.[0]?.inlineData).toBeTruthy();
	});
});

describe("Google Vertex thinking budget payload", () => {
	const stableFlashLite = getModel("google-vertex", "gemini-2.5-flash-lite");

	it.each([stableFlashLite, { ...stableFlashLite, id: "gemini-2.5-flash-lite-preview" }])(
		"uses the supported minimal budget for $id",
		async (model) => {
			let capturedPayload: GenerateContentParameters | undefined;
			await streamSimpleGoogleVertex(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "fake-key",
					reasoning: "minimal",
					onPayload: (payload) => {
						capturedPayload = payload as GenerateContentParameters;
						return payload;
					},
				},
			).result();

			expect(capturedPayload?.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 512 });
		},
	);
});

describe("Google thinking detection (thoughtSignature)", () => {
	it.each([
		{ part: { thought: true, thoughtSignature: undefined }, thinking: true },
		{ part: { thought: true, thoughtSignature: "opaque-signature" }, thinking: true },
		{ part: { thought: undefined, thoughtSignature: "opaque-signature" }, thinking: false },
		{ part: { thought: false, thoughtSignature: "opaque-signature" }, thinking: false },
		{ part: { thought: undefined, thoughtSignature: undefined }, thinking: false },
		{ part: { thought: false, thoughtSignature: "" }, thinking: false },
	])("isThinkingPart($part) === $thinking", ({ part, thinking }) => {
		expect(isThinkingPart(part)).toBe(thinking);
	});

	it.each([
		{ previous: undefined, next: "sig-1", expected: "sig-1" },
		{ previous: "sig-1", next: undefined, expected: "sig-1" },
		{ previous: "sig-1", next: "", expected: "sig-1" },
		{ previous: "sig-1", next: "sig-2", expected: "sig-2" },
	])("retainThoughtSignature($previous, $next) === $expected", ({ previous, next, expected }) => {
		expect(retainThoughtSignature(previous, next)).toBe(expected);
	});
});
