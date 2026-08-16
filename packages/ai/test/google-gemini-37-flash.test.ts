import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("Gemini 3.7 Flash Model & Thinking Levels", () => {
	it("registers gemini-3.7-flash for Google provider with full thinking levels", () => {
		const model = getModel("google", "gemini-3.7-flash");
		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.7-flash");
		expect(model.provider).toBe("google");
		expect(model.api).toBe("google-generative-ai");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: "MINIMAL",
			low: "LOW",
			medium: "MEDIUM",
			high: "HIGH",
		});

		const supportedLevels = getSupportedThinkingLevels(model);
		expect(supportedLevels).toEqual(["minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(model, "high")).toBe("high");
		expect(clampThinkingLevel(model, "medium")).toBe("medium");
		expect(clampThinkingLevel(model, "low")).toBe("low");
	});

	it("registers gemini-3.7-flash for Google Vertex provider with full thinking levels", () => {
		const model = getModel("google-vertex", "gemini-3.7-flash");
		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.7-flash");
		expect(model.provider).toBe("google-vertex");
		expect(model.api).toBe("google-vertex");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: "MINIMAL",
			low: "LOW",
			medium: "MEDIUM",
			high: "HIGH",
		});

		const supportedLevels = getSupportedThinkingLevels(model);
		expect(supportedLevels).toEqual(["minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(model, "high")).toBe("high");
	});
});
