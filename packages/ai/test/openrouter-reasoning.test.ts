import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.js";
import { getOpenRouterReasoningCapabilities } from "../src/openrouter-reasoning.js";
import type { Model } from "../src/types.js";

function supportedLevels(thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"]) {
	const model = {
		reasoning: true,
		thinkingLevelMap,
	} as Model<"openai-completions">;
	return getSupportedThinkingLevels(model);
}

function metadata(reasoning: Record<string, unknown>, supportsReasoning = true) {
	return {
		supported_parameters: supportsReasoning ? ["tools", "reasoning"] : ["tools"],
		reasoning,
	};
}

describe("OpenRouter reasoning metadata", () => {
	it("exposes exactly the published efforts and hides off for mandatory reasoning", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			metadata({
				mandatory: true,
				supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
			}),
		);

		expect(capabilities).toEqual({
			mandatory: true,
			supportsReasoningEffort: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		});
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("keeps off and only the advertised sparse efforts for optional reasoning", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			metadata({ mandatory: false, supported_efforts: ["high", "none"] }),
		);

		expect(capabilities?.supportsReasoningEffort).toBe(true);
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["off", "high"]);
	});

	it("treats null efforts as accepting every gateway effort", () => {
		const optional = getOpenRouterReasoningCapabilities(metadata({ mandatory: false, supported_efforts: null }));
		const mandatory = getOpenRouterReasoningCapabilities(metadata({ mandatory: true, supported_efforts: null }));

		expect(optional?.supportsReasoningEffort).toBe(true);
		expect(mandatory?.supportsReasoningEffort).toBe(true);
		expect(supportedLevels(optional?.thinkingLevelMap)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(supportedLevels(mandatory?.thinkingLevelMap)).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("uses a single active toggle when effort selection is not exposed", () => {
		const optional = getOpenRouterReasoningCapabilities(metadata({ mandatory: false }));
		const mandatory = getOpenRouterReasoningCapabilities(metadata({ mandatory: true }));

		expect(optional?.supportsReasoningEffort).toBe(false);
		expect(supportedLevels(optional?.thinkingLevelMap)).toEqual(["off", "high"]);
		expect(supportedLevels(mandatory?.thinkingLevelMap)).toEqual(["high"]);
	});

	it("falls back to an enabled toggle for malformed effort lists", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			metadata({ mandatory: false, supported_efforts: ["unexpected", 123] }),
		);

		expect(capabilities?.supportsReasoningEffort).toBe(false);
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["off", "high"]);
	});

	it("ignores the over-reported reasoning object when the route lacks the reasoning parameter", () => {
		expect(
			getOpenRouterReasoningCapabilities(metadata({ mandatory: true, supported_efforts: ["high"] }, false)),
		).toBeUndefined();
	});
});
