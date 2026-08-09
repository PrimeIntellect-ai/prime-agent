import { describe, expect, test } from "vitest";
import {
	childAllowance,
	DEFAULT_RLM_TOKEN_BUDGET_FANOUT,
	isRlmTokenBudgetConfig,
	normalizeRlmTokenBudgetRequest,
	ownAllowance,
	parseRlmTokenBudgetCommand,
	parseRlmTokenBudgetTokens,
	type RlmTokenBudgetConfig,
	subtreePool,
	validateRlmTokenBudgetConfig,
} from "../src/core/rlm-token-budget.js";

function config(overrides: Partial<RlmTokenBudgetConfig> = {}): RlmTokenBudgetConfig {
	return {
		totalTokens: 1_000_000,
		schedule: "split",
		factor: 0.5,
		fanout: DEFAULT_RLM_TOKEN_BUDGET_FANOUT,
		...overrides,
	};
}

/** Walk a full tree the way the session layer allocates allowances, returning total tokens grantable. */
function simulateTree(cfg: RlmTokenBudgetConfig, maxDepth: number, fanout: number): number {
	let total = 0;
	let layer = [cfg.totalTokens];
	for (let depth = 0; depth <= maxDepth; depth++) {
		const next: number[] = [];
		for (const allowance of layer) {
			total += ownAllowance(cfg, depth, allowance);
			const initialPool = subtreePool(cfg, allowance) ?? 0;
			const share = childAllowance(cfg, depth + 1, initialPool);
			let pool = initialPool;
			for (let child = 0; child < fanout; child++) {
				if (share <= 0 || pool < share) break;
				pool -= share;
				next.push(share);
			}
		}
		layer = next;
	}
	return total;
}

describe("rlm token budget schedules", () => {
	test("flat grants the same allowance at every depth", () => {
		const cfg = config({ schedule: "flat" });

		expect(ownAllowance(cfg, 0)).toBe(1_000_000);
		expect(ownAllowance(cfg, 5)).toBe(1_000_000);
		expect(subtreePool(cfg, 1_000_000)).toBeNull();
	});

	test("geometric gives each successive depth a factor share of the total", () => {
		const cfg = config({ schedule: "geometric", factor: 0.25 });

		expect(ownAllowance(cfg, 0)).toBe(1_000_000);
		expect(ownAllowance(cfg, 1)).toBe(250_000);
		expect(ownAllowance(cfg, 2)).toBe(62_500);
		expect(childAllowance(cfg, 2, null)).toBe(62_500);
	});

	test("split reserves the factor share for descendants and keeps the rest", () => {
		const cfg = config({ schedule: "split", factor: 0.5, fanout: 2 });

		expect(ownAllowance(cfg, 0, 1_000_000)).toBe(500_000);
		expect(subtreePool(cfg, 1_000_000)).toBe(500_000);
		expect(childAllowance(cfg, 1, 500_000)).toBe(250_000);
		// siblings receive identical shares of the pool the parent started with
		expect(childAllowance(cfg, 1, 500_000)).toBe(250_000);
	});

	test("split bounds the whole tree by the root allowance regardless of depth or fan-out", () => {
		const cfg = config({ schedule: "split", factor: 0.5, fanout: 3 });

		for (const fanout of [1, 3, 8]) {
			for (const maxDepth of [1, 4, 8]) {
				expect(simulateTree(cfg, maxDepth, fanout)).toBeLessThanOrEqual(cfg.totalTokens);
			}
		}
	});

	test("split refuses to fund children once the pool is drained", () => {
		const cfg = config({ schedule: "split", factor: 0.5, fanout: 3 });

		expect(childAllowance(cfg, 1, 0)).toBe(0);
		expect(childAllowance(cfg, 1, 2)).toBe(0);
	});

	test("allowances never fall below one token for the depth-indexed schedules", () => {
		const cfg = config({ schedule: "geometric", factor: 0.1 });

		expect(ownAllowance(cfg, 32)).toBe(1);
	});
});

describe("rlm token budget validation", () => {
	test("accepts a well-formed config", () => {
		expect(isRlmTokenBudgetConfig(config())).toBe(true);
		expect(validateRlmTokenBudgetConfig(config())).toEqual(config());
	});

	test("rejects malformed configs", () => {
		expect(isRlmTokenBudgetConfig({ ...config(), totalTokens: 0 })).toBe(false);
		expect(isRlmTokenBudgetConfig({ ...config(), factor: 0 })).toBe(false);
		expect(isRlmTokenBudgetConfig({ ...config(), factor: 1.5 })).toBe(false);
		expect(isRlmTokenBudgetConfig({ ...config(), schedule: "nope" })).toBe(false);
		expect(isRlmTokenBudgetConfig({ ...config(), fanout: 0 })).toBe(false);
		expect(isRlmTokenBudgetConfig(null)).toBe(false);
	});

	test("reports actionable validation errors", () => {
		expect(() => validateRlmTokenBudgetConfig({ ...config(), totalTokens: -1 })).toThrow(/positive integer/);
		expect(() => validateRlmTokenBudgetConfig({ ...config(), factor: 2 })).toThrow(/greater than 0/);
		expect(() => validateRlmTokenBudgetConfig({ ...config(), fanout: 0 })).toThrow(/fanout/);
	});
});

describe("rlm token budget command parsing", () => {
	test("no arguments reads status", () => {
		expect(parseRlmTokenBudgetCommand("")).toEqual({ kind: "status" });
		expect(parseRlmTokenBudgetCommand("   ")).toEqual({ kind: "status" });
	});

	test("off disables budgeting, optionally globally", () => {
		expect(parseRlmTokenBudgetCommand("off")).toEqual({ kind: "off", global: false });
		expect(parseRlmTokenBudgetCommand("off --global")).toEqual({ kind: "off", global: true });
	});

	test("applies schedule defaults", () => {
		expect(parseRlmTokenBudgetCommand("1000000")).toEqual({
			kind: "set",
			global: false,
			config: { totalTokens: 1_000_000, schedule: "split", factor: 0.5, fanout: 3 },
		});
	});

	test("accepts k and m suffixes and underscore separators", () => {
		expect(parseRlmTokenBudgetTokens("500k")).toBe(500_000);
		expect(parseRlmTokenBudgetTokens("2M")).toBe(2_000_000);
		expect(parseRlmTokenBudgetTokens("1_000_000")).toBe(1_000_000);
		expect(() => parseRlmTokenBudgetTokens("0")).toThrow(/Invalid token count/);
		expect(() => parseRlmTokenBudgetTokens("abc")).toThrow(/Invalid token count/);
	});

	test("parses every schedule knob in both flag forms", () => {
		expect(parseRlmTokenBudgetCommand("800k --schedule geometric --factor 0.25 --fanout 4 --global")).toEqual({
			kind: "set",
			global: true,
			config: { totalTokens: 800_000, schedule: "geometric", factor: 0.25, fanout: 4 },
		});
		expect(parseRlmTokenBudgetCommand("800k --schedule=flat --factor=0.75 --fanout=2")).toEqual({
			kind: "set",
			global: false,
			config: { totalTokens: 800_000, schedule: "flat", factor: 0.75, fanout: 2 },
		});
	});

	test("rejects malformed invocations with actionable errors", () => {
		expect(() => parseRlmTokenBudgetCommand("1000 --schedule bogus")).toThrow(/Unknown schedule/);
		expect(() => parseRlmTokenBudgetCommand("1000 --schedule")).toThrow(/Missing value for --schedule/);
		expect(() => parseRlmTokenBudgetCommand("1000 --factor 3")).toThrow(/greater than 0/);
		expect(() => parseRlmTokenBudgetCommand("1000 --fanout 0")).toThrow(/fanout/);
		expect(() => parseRlmTokenBudgetCommand("1000 bogus")).toThrow(/Unexpected argument/);
	});
});

describe("rlm token budget ranges", () => {
	test("clamps depth-indexed allowances into the configured range", () => {
		const cfg = config({ schedule: "geometric", factor: 0.1, minTokens: 20_000, maxTokens: 400_000 });

		// unclamped: 1000000, 100000, 10000 -> clamped by ceiling, untouched, raised to floor
		expect(ownAllowance(cfg, 0)).toBe(400_000);
		expect(ownAllowance(cfg, 1)).toBe(100_000);
		expect(ownAllowance(cfg, 2)).toBe(20_000);
	});

	test("applies only the ceiling under split so the subtree bound survives", () => {
		const cfg = config({ schedule: "split", factor: 0.5, minTokens: 900_000, maxTokens: 300_000 - 1 });

		// The floor would raise the allowance above what the parent reserved, so it is ignored here.
		expect(ownAllowance(cfg, 0, 1_000_000)).toBe(299_999);
	});

	test("keeps the tree bounded when a ceiling is configured", () => {
		const cfg = config({ schedule: "split", factor: 0.5, fanout: 3, maxTokens: 120_000 });

		for (const fanout of [1, 3, 8]) {
			expect(simulateTree(cfg, 6, fanout)).toBeLessThanOrEqual(cfg.totalTokens);
		}
	});

	test("validates range ordering", () => {
		expect(isRlmTokenBudgetConfig({ ...config(), minTokens: 10, maxTokens: 5 })).toBe(false);
		expect(isRlmTokenBudgetConfig({ ...config(), minTokens: 5, maxTokens: 10 })).toBe(true);
		expect(() => validateRlmTokenBudgetConfig({ ...config(), minTokens: 10, maxTokens: 5 })).toThrow(
			/floor 10 exceeds its ceiling 5/,
		);
	});

	test("parses the <floor>-<ceiling> command form", () => {
		expect(parseRlmTokenBudgetCommand("50k-600k")).toEqual({
			kind: "set",
			global: false,
			config: {
				totalTokens: 600_000,
				schedule: "split",
				factor: 0.5,
				fanout: 3,
				minTokens: 50_000,
				maxTokens: 600_000,
			},
		});
	});

	test("parses explicit floor and ceiling flags", () => {
		expect(parseRlmTokenBudgetCommand("1m --floor 50k --ceiling 400k")).toEqual({
			kind: "set",
			global: false,
			config: {
				totalTokens: 1_000_000,
				schedule: "split",
				factor: 0.5,
				fanout: 3,
				minTokens: 50_000,
				maxTokens: 400_000,
			},
		});
	});

	test("rejects an inverted range from the command line", () => {
		expect(() => parseRlmTokenBudgetCommand("600k-200k")).toThrow(/exceeds its ceiling/);
	});
});

describe("rlm token budget request normalization", () => {
	test("accepts a bare ceiling", () => {
		expect(normalizeRlmTokenBudgetRequest(500)).toEqual({ minTokens: 500, maxTokens: 500 });
		expect(normalizeRlmTokenBudgetRequest(undefined)).toBeUndefined();
	});

	test("accepts tuple and object range forms", () => {
		expect(normalizeRlmTokenBudgetRequest([200, 600])).toEqual({ minTokens: 200, maxTokens: 600 });
		expect(normalizeRlmTokenBudgetRequest({ min: 200, max: 600 })).toEqual({ minTokens: 200, maxTokens: 600 });
		expect(normalizeRlmTokenBudgetRequest({ minTokens: 200, maxTokens: 600 })).toEqual({
			minTokens: 200,
			maxTokens: 600,
		});
	});

	test("rejects malformed requests", () => {
		expect(() => normalizeRlmTokenBudgetRequest(0)).toThrow(/positive integer/);
		expect(() => normalizeRlmTokenBudgetRequest([600, 200])).toThrow(/floor 600 exceeds its ceiling 200/);
		expect(() => normalizeRlmTokenBudgetRequest([1, 2, 3])).toThrow(/floor, ceiling/);
		expect(() => normalizeRlmTokenBudgetRequest("lots")).toThrow(/floor, ceiling/);
	});
});

describe("rlm token budget misconfiguration guards", () => {
	test("rejects a split floor no child could ever be funded at", () => {
		// 600k total, split/0.5, fanout 3 -> pool 300k -> 100k per child, below a 200k floor.
		expect(() => parseRlmTokenBudgetCommand("200k-600k")).toThrow(/cannot be funded/);
		expect(() =>
			validateRlmTokenBudgetConfig({
				totalTokens: 600_000,
				schedule: "split",
				factor: 0.5,
				fanout: 3,
				minTokens: 200_000,
			}),
		).toThrow(/gives each of 3 children a 100000-token grant worth 50000 spendable tokens/);
	});

	test("accepts a split floor the schedule can fund", () => {
		expect(parseRlmTokenBudgetCommand("50k-1m")).toMatchObject({
			kind: "set",
			config: { totalTokens: 1_000_000, minTokens: 50_000, maxTokens: 1_000_000 },
		});
	});

	test("does not apply the split feasibility check to depth-indexed schedules", () => {
		// geometric raises a starved depth to the floor instead of refusing spawns.
		expect(() =>
			validateRlmTokenBudgetConfig({
				totalTokens: 600_000,
				schedule: "geometric",
				factor: 0.5,
				fanout: 3,
				minTokens: 200_000,
			}),
		).not.toThrow();
	});

	test("refuses to silently discard --floor/--ceiling when a range is also given", () => {
		expect(() => parseRlmTokenBudgetCommand("1m-2m --floor 50k")).toThrow(/Cannot combine the range/);
		expect(() => parseRlmTokenBudgetCommand("1m-2m --ceiling 400k")).toThrow(/Cannot combine the range/);
	});
});

describe("rlm token budget factor bounds", () => {
	test("rejects --factor 1 under split, which would leave every session one token", () => {
		expect(() => parseRlmTokenBudgetCommand("1m --factor 1")).toThrow(
			/factor must be less than 1 for the "split" schedule/,
		);
		expect(() => validateRlmTokenBudgetConfig({ ...config(), factor: 1 })).toThrow(/Lower --factor/);
		expect(isRlmTokenBudgetConfig({ ...config(), factor: 1 })).toBe(false);
	});

	test("keeps --factor 1 legal for the depth-indexed schedules", () => {
		expect(parseRlmTokenBudgetCommand("1m --schedule geometric --factor 1")).toEqual({
			kind: "set",
			global: false,
			config: { totalTokens: 1_000_000, schedule: "geometric", factor: 1, fanout: 3 },
		});
		expect(parseRlmTokenBudgetCommand("1m --schedule flat --factor 1")).toMatchObject({
			kind: "set",
			config: { schedule: "flat", factor: 1 },
		});
		expect(isRlmTokenBudgetConfig({ ...config(), schedule: "geometric", factor: 1 })).toBe(true);
	});
});

describe("rlm token budget guard and validator agreement", () => {
	const rejected: Array<[string, unknown]> = [
		["non-object", null],
		["zero total", { ...config(), totalTokens: 0 }],
		["unknown schedule", { ...config(), schedule: "nope" }],
		["factor above 1", { ...config(), factor: 1.5 }],
		["split factor of 1", { ...config(), factor: 1 }],
		["zero fanout", { ...config(), fanout: 0 }],
		["fractional floor", { ...config(), minTokens: 1.5 }],
		["inverted range", { ...config(), minTokens: 10, maxTokens: 5 }],
		[
			"unfundable split floor",
			{ totalTokens: 600_000, schedule: "split", factor: 0.5, fanout: 3, minTokens: 200_000 },
		],
	];

	test.each(rejected)("the type guard rejects the %s config the validator rejects", (_label, candidate) => {
		expect(() => validateRlmTokenBudgetConfig(candidate as RlmTokenBudgetConfig)).toThrow();
		expect(isRlmTokenBudgetConfig(candidate)).toBe(false);
	});

	test("a config the guard accepts also survives validation", () => {
		const persisted = { ...config(), minTokens: 50_000, maxTokens: 400_000 };

		expect(isRlmTokenBudgetConfig(persisted)).toBe(true);
		expect(validateRlmTokenBudgetConfig(persisted)).toEqual(persisted);
	});
});

describe("rlm token budget parser ordering", () => {
	test("off disables budgeting before any schedule flag is validated", () => {
		expect(parseRlmTokenBudgetCommand("off --schedule bogus")).toEqual({ kind: "off", global: false });
		expect(parseRlmTokenBudgetCommand("off --factor abc --global")).toEqual({ kind: "off", global: true });
		expect(() => parseRlmTokenBudgetCommand("off --globl")).toThrow(/Unexpected argument "--globl"/);
	});

	test("a leading flag reports the missing token count instead of a value error", () => {
		expect(() => parseRlmTokenBudgetCommand("--schedule flat")).toThrow(/Missing token count before "--schedule"/);
		expect(() => parseRlmTokenBudgetCommand("--global")).toThrow(/Missing token count before "--global"/);
	});
});

describe("rlm token budget flag value errors", () => {
	test("quotes an invalid --factor value", () => {
		expect(() => parseRlmTokenBudgetCommand("1m --factor abc")).toThrow(/Invalid factor "abc"/);
		expect(() => parseRlmTokenBudgetCommand("1m --factor=0")).toThrow(/Invalid factor "0"/);
	});

	test("quotes an invalid --fanout value", () => {
		expect(() => parseRlmTokenBudgetCommand("1m --fanout abc")).toThrow(/Invalid fanout "abc"/);
		expect(() => parseRlmTokenBudgetCommand("1m --fanout=2.5")).toThrow(/Invalid fanout "2.5"/);
	});
});

describe("rlm token count separators", () => {
	test("rejects a trailing underscore that made a malformed range parse", () => {
		expect(parseRlmTokenBudgetTokens("1_000")).toBe(1_000);
		expect(() => parseRlmTokenBudgetTokens("1_000_")).toThrow(/Invalid token count "1_000_"/);
		expect(() => parseRlmTokenBudgetCommand("1_000_-1m")).toThrow(/Invalid token count "1_000_"/);
	});
});
