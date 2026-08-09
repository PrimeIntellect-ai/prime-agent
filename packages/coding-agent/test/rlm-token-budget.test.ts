import { describe, expect, test } from "vitest";
import {
	childAllowance,
	DEFAULT_RLM_TOKEN_BUDGET_FANOUT,
	isRlmTokenBudgetConfig,
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
