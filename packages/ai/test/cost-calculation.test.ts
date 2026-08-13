import { describe, expect, it } from "vitest";
import { calculateCost } from "../src/models.js";
import type { Api, CostTier, Model, Usage } from "../src/types.js";

/**
 * Build a generic, non-provider model with explicit cost data so the
 * calculateCost contract is tested in isolation from the generated model
 * catalog (which another implementer owns).
 */
function makeModel(cost: Model<Api>["cost"]): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 8_000,
	};
}

function makeUsage(partial: Partial<Usage> = {}): Usage {
	const { cost: _ignored, ...rest } = partial;
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...rest,
	};
}

const baseCost: Model<Api>["cost"] = {
	input: 1, // $1 / 1M input tokens
	output: 2, // $2 / 1M output tokens
	cacheRead: 0.1,
	cacheWrite: 1.25,
};

describe("calculateCost — tier resolution (strict >)", () => {
	const tier256k: CostTier = {
		contextThreshold: 256_000,
		input: 2,
		output: 4,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	};

	it("uses base rates when total input usage is below the first tier", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 100_000 });

		const cost = calculateCost(model, usage);

		expect(cost.input).toBeCloseTo(0.1, 10); // 1 * 100k / 1M
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
	});

	it("uses base rates when total input usage is EXACTLY equal to the threshold (strict >)", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 256_000 });

		const cost = calculateCost(model, usage);

		// Total input usage is 256000 which is NOT strictly greater than 256000,
		// so the base rates (1, 2, 0.1, 1.25) win.
		expect(cost.input).toBeCloseTo(0.256, 10); // 1 * 256k / 1M
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
	});

	it("applies the tier when total input usage is strictly above the threshold", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 256_001 });

		const cost = calculateCost(model, usage);

		// Just one token past the threshold → tier rates apply.
		expect(cost.input).toBeCloseTo((2 * 256_001) / 1_000_000, 10);
		expect(cost.output).toBe(0);
	});

	it("picks the HIGHEST matching tier (not the first) when tiers are unsorted", () => {
		const tier256k: CostTier = {
			contextThreshold: 256_000,
			input: 2,
			output: 4,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		};
		const tier1m: CostTier = {
			contextThreshold: 1_000_000,
			input: 4,
			output: 8,
			cacheRead: 0.4,
			cacheWrite: 5,
		};
		const tier128k: CostTier = {
			contextThreshold: 128_000,
			input: 1.5,
			output: 3,
			cacheRead: 0.15,
			cacheWrite: 1.875,
		};
		const model = makeModel({ ...baseCost, tiers: [tier256k, tier1m, tier128k] });
		const usage = makeUsage({ input: 2_000_000 });

		const cost = calculateCost(model, usage);

		// All three tiers match (2M > 256k, > 1M, > 128k); the 1M-tier wins
		// because it has the highest threshold.
		expect(cost.input).toBeCloseTo((4 * 2_000_000) / 1_000_000, 10);
		expect(cost.output).toBe(0);
	});
});

describe("calculateCost — cache-token contribution to the threshold", () => {
	const tier256k: CostTier = {
		contextThreshold: 256_000,
		input: 2,
		output: 4,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	};

	it("counts cacheRead tokens toward the tier threshold", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 100_000, cacheRead: 156_001 });

		const cost = calculateCost(model, usage);

		// 100k input + 156001 cacheRead = 256001 → tier applies.
		expect(cost.input).toBeCloseTo((2 * 100_000) / 1_000_000, 10);
		expect(cost.cacheRead).toBeCloseTo((0.2 * 156_001) / 1_000_000, 10);
	});

	it("counts cacheWrite tokens toward the tier threshold", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 100_000, cacheWrite: 156_001 });

		const cost = calculateCost(model, usage);

		// 100k input + 156001 cacheWrite = 256001 → tier applies.
		expect(cost.input).toBeCloseTo((2 * 100_000) / 1_000_000, 10);
		expect(cost.cacheWrite).toBeCloseTo((2.5 * 156_001) / 1_000_000, 10);
	});

	it("uses base rates when total input usage including cache tokens is exactly the threshold", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		const usage = makeUsage({ input: 100_000, cacheRead: 100_000, cacheWrite: 56_000 });

		const cost = calculateCost(model, usage);

		// 100k + 100k + 56k = 256000 exactly → base rates win (strict >).
		expect(cost.input).toBeCloseTo((1 * 100_000) / 1_000_000, 10);
		expect(cost.cacheRead).toBeCloseTo((0.1 * 100_000) / 1_000_000, 10);
		expect(cost.cacheWrite).toBeCloseTo((1.25 * 56_000) / 1_000_000, 10);
	});

	it("ignores output tokens for tier selection (only input + cache counts)", () => {
		const model = makeModel({ ...baseCost, tiers: [tier256k] });
		// Huge output, tiny input — must still stay on the base tier.
		const usage = makeUsage({ input: 1, output: 10_000_000 });

		const cost = calculateCost(model, usage);

		// Output does NOT push us into the tier; base rates apply for input.
		expect(cost.input).toBeCloseTo((1 * 1) / 1_000_000, 12);
		// Output is priced on base output rate.
		expect(cost.output).toBeCloseTo((2 * 10_000_000) / 1_000_000, 10);
	});
});

describe("calculateCost — service-tier multiplier", () => {
	const model = makeModel({ ...baseCost, serviceTierMultipliers: { priority: 1.5 } });

	it("applies the model-declated priority multiplier to all four cost components", () => {
		const usage = makeUsage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });

		const cost = calculateCost(model, usage, { serviceTier: "priority" });

		// Each component is 1 token / 1M * base rate, then * 1.5.
		expect(cost.input).toBeCloseTo(1 * 1.5, 10);
		expect(cost.output).toBeCloseTo(2 * 1.5, 10);
		expect(cost.cacheRead).toBeCloseTo(0.1 * 1.5, 10);
		expect(cost.cacheWrite).toBeCloseTo(1.25 * 1.5, 10);
		expect(cost.total).toBeCloseTo((1 + 2 + 0.1 + 1.25) * 1.5, 10);
	});

	it("treats an unknown / missing service tier as a no-op (multiplier 1)", () => {
		const usage = makeUsage({ input: 1_000_000, output: 1_000_000 });

		const costNoOverride = calculateCost(model, usage);
		expect(costNoOverride.input).toBeCloseTo(1, 10);
		expect(costNoOverride.output).toBeCloseTo(2, 10);

		const costUnknown = calculateCost(model, usage, { serviceTier: "flex" });
		expect(costUnknown.input).toBeCloseTo(1, 10);
		expect(costUnknown.output).toBeCloseTo(2, 10);
	});

	it("treats null serviceTier as a no-op", () => {
		const usage = makeUsage({ input: 1_000_000, output: 1_000_000 });

		const cost = calculateCost(model, usage, { serviceTier: null });

		expect(cost.input).toBeCloseTo(1, 10);
		expect(cost.output).toBeCloseTo(2, 10);
	});

	it("applies the multiplier AFTER the cacheWrite override", () => {
		const usage = makeUsage({ cacheWrite: 1_000_000 });

		const cost = calculateCost(
			model,
			usage,
			{ cacheWrite: 10, serviceTier: "priority" }, // base 1.25, override 10, then * 1.5 = 15
		);

		expect(cost.cacheWrite).toBeCloseTo(10 * 1.5, 10);
	});
});

describe("calculateCost — backward compatibility (no tiers, no serviceTier)", () => {
	it("matches the original calculateCost behavior when no tiers or multipliers are declared", () => {
		const model = makeModel({ ...baseCost });
		const usage = makeUsage({
			input: 1_000_000,
			output: 500_000,
			cacheRead: 2_000_000,
			cacheWrite: 100_000,
		});

		const cost = calculateCost(model, usage);

		// 1 * 1 + 2 * 0.5 + 0.1 * 2 + 1.25 * 0.1 = 1 + 1 + 0.2 + 0.125 = 2.325
		expect(cost.input).toBeCloseTo(1, 10);
		expect(cost.output).toBeCloseTo(1, 10);
		expect(cost.cacheRead).toBeCloseTo(0.2, 10);
		expect(cost.cacheWrite).toBeCloseTo(0.125, 10);
		expect(cost.total).toBeCloseTo(2.325, 10);
	});

	it("preserves cacheWrite override behavior when no tiers are declared", () => {
		const model = makeModel({ ...baseCost });
		const usage = makeUsage({ cacheWrite: 1_000_000 });

		const cost = calculateCost(model, usage, { cacheWrite: 10 });

		// Override (10) wins over model.cost.cacheWrite (1.25).
		expect(cost.cacheWrite).toBeCloseTo(10, 10);
	});
});

describe("calculateCost — combined tier + priority multiplier", () => {
	const tier256k: CostTier = {
		contextThreshold: 256_000,
		input: 2,
		output: 4,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	};
	const tier1m: CostTier = {
		contextThreshold: 1_000_000,
		input: 4,
		output: 8,
		cacheRead: 0.4,
		cacheWrite: 5,
	};
	const model = makeModel({
		...baseCost,
		tiers: [tier256k, tier1m],
		serviceTierMultipliers: { priority: 1.5 },
	});

	it("picks the matching tier and then applies the priority multiplier on top", () => {
		const usage = makeUsage({ input: 512_000 });

		const cost = calculateCost(model, usage, { serviceTier: "priority" });

		// 512k > 256k → tier256k rates (2, 4, 0.2, 2.5), then * 1.5.
		expect(cost.input).toBeCloseTo((2 * 512_000 * 1.5) / 1_000_000, 10);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
		expect(cost.total).toBeCloseTo(cost.input, 10);
	});

	it("treats exactly the threshold as base tier even with priority multiplier set", () => {
		const usage = makeUsage({ input: 256_000 });

		const cost = calculateCost(model, usage, { serviceTier: "priority" });

		// 256k is NOT strictly > 256k, so base rates (1, 2, 0.1, 1.25) apply,
		// then * 1.5.
		expect(cost.input).toBeCloseTo((1 * 256_000 * 1.5) / 1_000_000, 10);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
	});

	it("uses the highest matching tier and the priority multiplier together", () => {
		const usage = makeUsage({ input: 2_000_000 });

		const cost = calculateCost(model, usage, { serviceTier: "priority" });

		// 2M > 1M and > 256k → tier1m rates (4, 8, 0.4, 5), then * 1.5.
		expect(cost.input).toBeCloseTo((4 * 2_000_000 * 1.5) / 1_000_000, 10);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
	});

	it("preserves cacheWrite override: override wins over tier, then multiplier applies", () => {
		// 256_000 input is the 256k tier; adding any cacheWrite pushes total
		// input usage above the 1M tier too, so we use the 1M tier for input
		// rates but the caller-supplied cacheWrite override still wins.
		const usage = makeUsage({ input: 256_000, cacheWrite: 1_000_000 });

		const cost = calculateCost(model, usage, {
			cacheWrite: 7, // override beats tier1m's cacheWrite (5)
			serviceTier: "priority",
		});

		// input: tier1m (4) * 256000 / 1M = 1.024, * 1.5 = 1.536
		expect(cost.input).toBeCloseTo((4 * 256_000 * 1.5) / 1_000_000, 10);
		// cacheWrite: override 7 * 1M / 1M = 7, * 1.5 = 10.5
		expect(cost.cacheWrite).toBeCloseTo(7 * 1.5, 10);
	});
});
