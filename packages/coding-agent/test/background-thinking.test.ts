import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { backgroundThinkingLevel } from "../src/core/background-thinking.js";

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	};
}

const MANDATORY_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

describe("backgroundThinkingLevel", () => {
	it("returns undefined for non-reasoning models", () => {
		expect(backgroundThinkingLevel(createModel({ reasoning: false }), "high")).toBeUndefined();
	});

	it("requests thinking off when the model supports disabling it", () => {
		const model = createModel();
		expect(backgroundThinkingLevel(model)).toBe("off");
		expect(backgroundThinkingLevel(model, "off")).toBe("off");
	});

	it("returns the lowest supported effort for mandatory-thinking models", () => {
		const model = createModel({ thinkingLevelMap: MANDATORY_MAP });
		expect(backgroundThinkingLevel(model)).toBe("low");
		expect(backgroundThinkingLevel(model, "off")).toBe("low");
	});

	it("clamps a requested level for mandatory-thinking models", () => {
		const model = createModel({ thinkingLevelMap: MANDATORY_MAP });
		expect(backgroundThinkingLevel(model, "high")).toBe("high");
		expect(backgroundThinkingLevel(model, "medium")).toBe("high");
	});

	it("falls forward to the first supported effort on sparse mandatory maps", () => {
		const model = createModel({
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		});
		expect(backgroundThinkingLevel(model, "off")).toBe("high");
	});
});
