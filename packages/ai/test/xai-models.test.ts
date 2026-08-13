import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("xAI models", () => {
	it("registers Grok 4.6 on the Responses API with published reasoning metadata", () => {
		const model = getModel("xai", "grok-4.6");

		expect(model).toBeDefined();
		expect(model.id).toBe("grok-4.6");
		expect(model.name).toBe("Grok 4.6");
		expect(model.api).toBe("openai-responses");
		expect(model.provider).toBe("xai");
		expect(model.baseUrl).toBe("https://api.x.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(500000);
		expect(model.maxTokens).toBe(500000);
		expect(model.cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({ supportsLongCacheRetention: false });
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh"]);
	});
});
