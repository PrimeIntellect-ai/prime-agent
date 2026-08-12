import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";

describe("MiniMax models", () => {
	for (const provider of ["minimax", "minimax-cn"] as const) {
		it(`registers MiniMax-M3 for ${provider}`, () => {
			const model = getModel(provider, "MiniMax-M3");

			expect(model.api).toBe("anthropic-messages");
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.contextWindow).toBe(1000000);
			expect(model.maxTokens).toBe(128000);
		});
	}
});
