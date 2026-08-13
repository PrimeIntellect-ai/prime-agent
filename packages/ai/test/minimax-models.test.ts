import { describe, expect, it } from "vitest";
import { calculateCost, getModel } from "../src/models.js";
import type { Usage } from "../src/types.js";

function usage(input: number, output = 0, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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
			tiers: [{ contextThreshold: 512_000, input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 }],
			serviceTierMultipliers: { priority: 1.5 },
		});
	});
});

describe("MiniMax-M3 tiered calculateCost", () => {
	it.each(["minimax", "minimax-cn"] as const)(
		"uses base rates below and at the 512000 context threshold for %s",
		(provider) => {
			const model = getModel(provider, "MiniMax-M3");

			// Cache tokens count toward the threshold, so use cacheRead/cacheWrite 0 here.
			const below = calculateCost(model, usage(512_000 - 1, 100));
			expect(below.input).toBeCloseTo(((512_000 - 1) * 0.3) / 1_000_000);
			expect(below.output).toBeCloseTo((100 * 1.2) / 1_000_000);
			expect(below.cacheRead).toBe(0);
			expect(below.cacheWrite).toBe(0);

			const at = calculateCost(model, usage(512_000, 100));
			expect(at.input).toBeCloseTo((512_000 * 0.3) / 1_000_000);
			expect(at.output).toBeCloseTo((100 * 1.2) / 1_000_000);
			expect(at.cacheRead).toBe(0);
			expect(at.cacheWrite).toBe(0);
		},
	);

	it("applies the long-context tier strictly above 512000", () => {
		const model = getModel("minimax", "MiniMax-M3");
		const above = calculateCost(model, usage(512_001, 100, 50, 10));
		expect(above.input).toBeCloseTo((512_001 * 0.6) / 1_000_000);
		expect(above.output).toBeCloseTo((100 * 2.4) / 1_000_000);
		expect(above.cacheRead).toBeCloseTo((50 * 0.12) / 1_000_000);
		expect(above.cacheWrite).toBeCloseTo((10 * 0) / 1_000_000);
	});

	it("counts cacheRead and cacheWrite toward the context threshold", () => {
		const model = getModel("minimax", "MiniMax-M3");
		// input + cacheRead + cacheWrite = 500000 + 10000 + 2000 = 512000 (at threshold -> base)
		const at = calculateCost(model, usage(500_000, 0, 10_000, 2_000));
		expect(at.input).toBeCloseTo((500_000 * 0.3) / 1_000_000);
		// 500000 + 10000 + 2001 = 512001 (above -> long-context tier)
		const above = calculateCost(model, usage(500_000, 0, 10_000, 2_001));
		expect(above.input).toBeCloseTo((500_000 * 0.6) / 1_000_000);
	});

	it("applies the priority multiplier at base and long-context tiers", () => {
		const model = getModel("minimax", "MiniMax-M3");

		const base = calculateCost(model, usage(1_000, 500, 200, 100), { serviceTier: "priority" });
		expect(base.input).toBeCloseTo((1_000 * 0.3 * 1.5) / 1_000_000);
		expect(base.output).toBeCloseTo((500 * 1.2 * 1.5) / 1_000_000);
		expect(base.cacheRead).toBeCloseTo((200 * 0.06 * 1.5) / 1_000_000);
		expect(base.cacheWrite).toBeCloseTo((100 * 0 * 1.5) / 1_000_000);

		const longTier = calculateCost(model, usage(600_000, 500, 200, 100), { serviceTier: "priority" });
		expect(longTier.input).toBeCloseTo((600_000 * 0.6 * 1.5) / 1_000_000);
		expect(longTier.output).toBeCloseTo((500 * 2.4 * 1.5) / 1_000_000);
		expect(longTier.cacheRead).toBeCloseTo((200 * 0.12 * 1.5) / 1_000_000);
		expect(longTier.cacheWrite).toBeCloseTo((100 * 0 * 1.5) / 1_000_000);
		expect(longTier.total).toBeCloseTo(
			(600_000 * 0.6 * 1.5 + 500 * 2.4 * 1.5 + 200 * 0.12 * 1.5 + 100 * 0 * 1.5) / 1_000_000,
		);
	});
});
