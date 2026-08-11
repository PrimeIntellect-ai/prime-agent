import { describe, expect, test } from "vitest";
import {
	isRlmTokenBudgetConfig,
	normalizeRlmTokenBudgetRequest,
	parseRlmTokenBudgetCommand,
	parseRlmTokenBudgetTokens,
	type RlmTokenBudgetConfig,
	validateRlmTokenBudgetConfig,
} from "../src/core/rlm-token-budget.js";

function config(overrides: Partial<RlmTokenBudgetConfig> = {}): RlmTokenBudgetConfig {
	return { totalTokens: 1_000_000, ...overrides };
}

describe("rlm token budget validation", () => {
	test("accepts a well-formed config", () => {
		expect(isRlmTokenBudgetConfig(config())).toBe(true);
		expect(isRlmTokenBudgetConfig(config({ minTokens: 1000, maxTokens: 400_000 }))).toBe(true);
	});

	test("rejects malformed configs", () => {
		expect(isRlmTokenBudgetConfig(null)).toBe(false);
		expect(isRlmTokenBudgetConfig({})).toBe(false);
		expect(isRlmTokenBudgetConfig(config({ totalTokens: 0 }))).toBe(false);
		expect(isRlmTokenBudgetConfig(config({ totalTokens: 1.5 }))).toBe(false);
		expect(isRlmTokenBudgetConfig(config({ minTokens: 0 }))).toBe(false);
		expect(isRlmTokenBudgetConfig(config({ minTokens: 600, maxTokens: 200 }))).toBe(false);
	});

	test("reports actionable validation errors", () => {
		expect(() => validateRlmTokenBudgetConfig(config({ totalTokens: -1 }))).toThrow(/positive integer/);
		expect(() => validateRlmTokenBudgetConfig(config({ minTokens: 600, maxTokens: 200 }))).toThrow(
			/floor 600 exceeds its ceiling 200/,
		);
	});

	test("rejects a floor no child could ever be funded at", () => {
		expect(() => validateRlmTokenBudgetConfig(config({ totalTokens: 1000, minTokens: 5000 }))).toThrow(
			/floor 5000 exceeds the 1000-token budget/,
		);
	});

	test("a config the guard accepts also survives validation", () => {
		const candidate = config({ minTokens: 1000, maxTokens: 500_000 });
		expect(isRlmTokenBudgetConfig(candidate)).toBe(true);
		expect(() => validateRlmTokenBudgetConfig(candidate)).not.toThrow();
	});
});

describe("rlm token budget command parsing", () => {
	test("no arguments reads status", () => {
		expect(parseRlmTokenBudgetCommand("")).toEqual({ kind: "status" });
		expect(parseRlmTokenBudgetCommand("   ")).toEqual({ kind: "status" });
	});

	test("off disables budgeting, optionally globally", () => {
		expect(parseRlmTokenBudgetCommand("off")).toEqual({ kind: "off", global: false });
		expect(parseRlmTokenBudgetCommand("none --global")).toEqual({ kind: "off", global: true });
		expect(parseRlmTokenBudgetCommand("clear")).toEqual({ kind: "off", global: false });
	});

	test("a bare token count is the whole budget", () => {
		expect(parseRlmTokenBudgetCommand("400k")).toEqual({
			kind: "set",
			config: { totalTokens: 400_000 },
			global: false,
		});
	});

	test("accepts k and m suffixes and underscore separators", () => {
		expect(parseRlmTokenBudgetTokens("500k")).toBe(500_000);
		expect(parseRlmTokenBudgetTokens("2m")).toBe(2_000_000);
		expect(parseRlmTokenBudgetTokens("1_000_000")).toBe(1_000_000);
	});

	test("rejects malformed invocations with actionable errors", () => {
		expect(() => parseRlmTokenBudgetCommand("lots")).toThrow(/Invalid token count/);
		expect(() => parseRlmTokenBudgetCommand("400k --nope")).toThrow(/Unexpected argument/);
		expect(() => parseRlmTokenBudgetCommand("400k --floor")).toThrow(/--floor/);
	});

	test("off disables budgeting before any range flag is validated", () => {
		expect(parseRlmTokenBudgetCommand("off --floor nonsense")).toEqual({ kind: "off", global: false });
	});

	test("a leading flag reports the missing token count instead of a value error", () => {
		expect(() => parseRlmTokenBudgetCommand("--floor 10k")).toThrow(/Missing token count/);
	});
});

describe("rlm token budget ranges", () => {
	test("parses the <floor>-<ceiling> command form", () => {
		expect(parseRlmTokenBudgetCommand("200k-600k")).toEqual({
			kind: "set",
			config: { totalTokens: 600_000, minTokens: 200_000, maxTokens: 600_000 },
			global: false,
		});
	});

	test("parses explicit floor and ceiling flags", () => {
		expect(parseRlmTokenBudgetCommand("1m --floor 50k --ceiling 400k")).toEqual({
			kind: "set",
			config: { totalTokens: 1_000_000, minTokens: 50_000, maxTokens: 400_000 },
			global: false,
		});
	});

	test("rejects an inverted range from the command line", () => {
		expect(() => parseRlmTokenBudgetCommand("600k-200k")).toThrow(/floor 600000 exceeds its ceiling 200000/);
	});

	test("refuses to silently discard --floor/--ceiling when a range is also given", () => {
		expect(() => parseRlmTokenBudgetCommand("200k-600k --floor 10k")).toThrow(/Cannot combine the range/);
	});

	test("validates range ordering", () => {
		expect(() => validateRlmTokenBudgetConfig(config({ minTokens: 600, maxTokens: 200 }))).toThrow(
			/floor 600 exceeds its ceiling 200/,
		);
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

describe("rlm token count separators", () => {
	test("rejects a trailing underscore that made a malformed range parse", () => {
		expect(parseRlmTokenBudgetTokens("1_000")).toBe(1_000);
		expect(() => parseRlmTokenBudgetTokens("1_000_")).toThrow(/Invalid token count "1_000_"/);
		expect(() => parseRlmTokenBudgetCommand("1_000_-1m")).toThrow(/Invalid token count "1_000_"/);
	});
});
