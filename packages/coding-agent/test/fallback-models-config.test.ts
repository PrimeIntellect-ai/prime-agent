import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { resolveFallbackModels, resolveFallbackModelsFromModels } from "../src/core/model-resolver.js";

const models: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

describe("--fallback-models CLI flag", () => {
	test("parses a comma separated chain", () => {
		const result = parseArgs(["--fallback-models", "anthropic/claude-sonnet-4-5,openai/gpt-4o"]);
		expect(result.fallbackModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
	});

	test("trims whitespace and drops empty entries", () => {
		const result = parseArgs(["--fallback-models", " anthropic/claude-sonnet-4-5 , , openai/gpt-4o "]);
		expect(result.fallbackModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
	});

	test("is absent when the flag is not passed", () => {
		expect(parseArgs([]).fallbackModels).toBeUndefined();
	});

	test("reports an error when the value is empty", () => {
		const result = parseArgs(["--fallback-models", "  "]);
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("--fallback-models"))).toBe(true);
	});
});

describe("resolveFallbackModelsFromModels", () => {
	test("resolves entries in order", () => {
		const resolved = resolveFallbackModelsFromModels(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"], models);
		expect(resolved.map((m) => `${m.provider}/${m.id}`)).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
		expect(resolved).toHaveLength(2);
	});

	test("rejects an unknown provider with an actionable error", () => {
		expect(() => resolveFallbackModelsFromModels(["nosuchprovider/some-model"], models)).toThrow(
			/fallbackModels.*nosuchprovider\/some-model/s,
		);
	});

	test("rejects an unknown model id with an actionable error", () => {
		expect(() => resolveFallbackModelsFromModels(["anthropic/not-a-real-model"], models)).toThrow(
			/fallbackModels.*anthropic\/not-a-real-model/s,
		);
	});

	test("rejects an empty model id", () => {
		expect(() => resolveFallbackModelsFromModels(["anthropic/"], models)).toThrow(/fallbackModels/);
	});

	test("rejects a blank entry", () => {
		expect(() => resolveFallbackModelsFromModels(["   "], models)).toThrow(/fallbackModels/);
	});

	test("deduplicates repeated entries while keeping order", () => {
		const resolved = resolveFallbackModelsFromModels(
			["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
			models,
		);
		expect(resolved.map((m) => `${m.provider}/${m.id}`)).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
	});

	test("returns an empty chain for an empty list", () => {
		expect(resolveFallbackModelsFromModels([], models)).toEqual([]);
	});

	test("is exported for registry-backed resolution", () => {
		expect(typeof resolveFallbackModels).toBe("function");
	});
});
