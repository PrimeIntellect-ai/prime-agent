import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model, Tool } from "../src/types.js";
import {
	flattenExclusiveRequiredUnion,
	hasXaiRootObjectUnion,
	prepareCompletionsToolParameters,
} from "../src/utils/xai-tool-schema.js";

interface ChatCompletionsPayload {
	tool_choice?: unknown;
	tools?: Array<{ type?: string; function?: { name?: string; parameters?: { anyOf?: unknown } } }>;
}

const coverageTool: Tool = {
	name: "mcp__codebase_memory_check_index_coverage",
	description: "coverage",
	parameters: {
		type: "object",
		properties: {
			project: { type: "string" },
			paths: { type: "array", items: { type: "string" } },
			scopes: { type: "array", items: { type: "string" } },
		},
		required: ["project"],
		anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
	} as unknown as Tool["parameters"],
};

const leftoverTool: Tool = {
	name: "mcp__leftover_union",
	description: "union",
	parameters: {
		type: "object",
		properties: { kind: { type: "string" } },
		anyOf: [
			{ required: ["kind"], minProperties: 1 },
			{ required: ["kind"], minProperties: 2 },
		],
	} as unknown as Tool["parameters"],
};

const goodTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function makeModel(provider: "openai" | "xai" | "xai-oauth"): Model<"openai-completions"> {
	return {
		id: provider === "openai" ? "gpt-4o-mini" : "grok-4.6",
		name: provider === "openai" ? "GPT-4o Mini" : "Grok 4.6",
		api: "openai-completions",
		provider,
		baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://api.x.ai/v1",
		reasoning: provider !== "openai",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	provider: "openai" | "xai" | "xai-oauth",
	tools: Tool[],
	toolChoice?: OpenAICompletionsToolChoice,
): Promise<ChatCompletionsPayload> {
	return new Promise((resolve) => {
		const context: Context = {
			messages: [{ role: "user", content: "check coverage", timestamp: 0 }],
			tools,
		};
		streamOpenAICompletions(makeModel(provider), context, {
			apiKey: "test-key",
			toolChoice,
			signal: abortedSignal(),
			onPayload: (payload) => {
				resolve(payload as ChatCompletionsPayload);
				return payload;
			},
		});
	});
}

type OpenAICompletionsToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

function toolNames(payload: ChatCompletionsPayload): Array<string | undefined> {
	return payload.tools?.map((tool) => tool.function?.name) ?? [];
}

describe("flattenExclusiveRequiredUnion", () => {
	it("flattens exclusive-required anyOf at the tool root", () => {
		const schema = {
			type: "object",
			properties: {
				project: { type: "string" },
				paths: { type: "array" },
				scopes: { type: "array" },
			},
			required: ["project"],
			anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
		};
		flattenExclusiveRequiredUnion(schema);
		expect(schema.anyOf).toBeUndefined();
		expect(schema.required).toEqual(["project"]);
	});

	it("does not flatten nested exclusive-required anyOf", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: {
				outputSchema: {
					type: "object",
					anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
				},
			},
		};
		flattenExclusiveRequiredUnion(schema);
		expect(schema.anyOf).toBeUndefined();
		const properties = schema.properties as Record<string, { anyOf: unknown }>;
		expect(properties.outputSchema.anyOf).toEqual([{ required: ["paths"] }, { required: ["scopes"] }]);
	});

	it("does not flatten a root union that constrains existing properties", () => {
		const schema = {
			type: "object",
			properties: { kind: { type: "string" } },
			anyOf: [{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }],
		};
		flattenExclusiveRequiredUnion(schema);
		expect(schema.anyOf).toHaveLength(2);
	});
});

describe("hasXaiRootObjectUnion", () => {
	it("flags leftover exclusive-required plus extra constraints", () => {
		expect(
			hasXaiRootObjectUnion({
				type: "object",
				properties: { kind: { type: "string" } },
				anyOf: [
					{ required: ["kind"], minProperties: 1 },
					{ required: ["kind"], minProperties: 2 },
				],
			}),
		).toBe(true);
	});

	it("accepts a root anyOf of typed object branches", () => {
		expect(
			hasXaiRootObjectUnion({
				anyOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "number" } } },
				],
			}),
		).toBe(false);
	});
});

describe("prepareCompletionsToolParameters", () => {
	it("keeps an exclusive-required MCP schema after flatten", () => {
		const prepared = prepareCompletionsToolParameters(coverageTool.parameters, {
			rejectXaiRootObjectUnion: true,
		});
		expect("drop" in prepared).toBe(false);
		if ("drop" in prepared) return;
		expect(prepared.parameters.anyOf).toBeUndefined();
	});

	it("drops leftover object-root unions only when the xAI option is on", () => {
		expect(prepareCompletionsToolParameters(leftoverTool.parameters, { rejectXaiRootObjectUnion: false })).toEqual(
			expect.objectContaining({ parameters: expect.objectContaining({ anyOf: expect.any(Array) }) }),
		);
		expect(prepareCompletionsToolParameters(leftoverTool.parameters, { rejectXaiRootObjectUnion: true })).toEqual({
			drop: true,
		});
	});
});

describe("openai-completions xAI leftover-union quarantine", () => {
	it("keeps an exclusive-required MCP tool after wire flatten on paid xAI", async () => {
		const payload = await capturePayload("xai", [coverageTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toBeUndefined();
	});

	it("keeps an exclusive-required MCP tool after wire flatten on xai-oauth", async () => {
		const payload = await capturePayload("xai-oauth", [coverageTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toBeUndefined();
	});

	it("keeps a leftover object-root union on OpenAI Completions", async () => {
		const payload = await capturePayload("openai", [leftoverTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__leftover_union", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toHaveLength(2);
	});

	it("quarantines a leftover object-root union on paid xAI only", async () => {
		const payload = await capturePayload("xai", [leftoverTool, goodTool]);
		expect(toolNames(payload)).toEqual(["read_file"]);
	});

	it("quarantines a leftover object-root union on xai-oauth", async () => {
		const payload = await capturePayload("xai-oauth", [leftoverTool, goodTool]);
		expect(toolNames(payload)).toEqual(["read_file"]);
	});

	it("drops a forced tool_choice when the leftover-union tool was quarantined", async () => {
		const payload = await capturePayload("xai", [leftoverTool, goodTool], {
			type: "function",
			function: { name: "mcp__leftover_union" },
		});
		expect(toolNames(payload)).toEqual(["read_file"]);
		expect(payload.tool_choice).toBeUndefined();
	});
});
