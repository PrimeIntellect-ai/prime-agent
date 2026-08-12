import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";

describe("MiniMax-M3 direct models", () => {
	it.each([
		["minimax", "https://api.minimax.io/anthropic"],
		["minimax-cn", "https://api.minimaxi.com/anthropic"],
	] as const)("registers MiniMax-M3 for %s", (provider, baseUrl) => {
		const model = getModel(provider, "MiniMax-M3");

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.provider).toBe(provider);
		expect(model.baseUrl).toBe(baseUrl);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0,
		});
	});
});
