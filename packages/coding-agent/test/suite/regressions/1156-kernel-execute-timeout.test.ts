import { describe, expect, it } from "vitest";
import { resolveExecuteTimeoutMs } from "../../../src/core/tools/ipython.js";

describe("issue #1156 kernel execute timeout", () => {
	it("leaves cells unbounded when no timeout is configured", () => {
		expect(resolveExecuteTimeoutMs(undefined)).toBe(0);
	});

	it("converts a configured timeout to milliseconds", () => {
		expect(resolveExecuteTimeoutMs(30)).toBe(30_000);
		expect(resolveExecuteTimeoutMs(1)).toBe(1_000);
	});

	it("rounds fractional seconds rather than passing a fractional delay to setTimeout", () => {
		expect(resolveExecuteTimeoutMs(1.5)).toBe(1_500);
		expect(resolveExecuteTimeoutMs(0.4)).toBe(400);
	});

	// 0 is the documented way to opt out, so it must mean "unbounded" and never
	// "interrupt immediately", which would kill every cell the moment it starts.
	it("treats zero and negative values as disabled", () => {
		expect(resolveExecuteTimeoutMs(0)).toBe(0);
		expect(resolveExecuteTimeoutMs(-1)).toBe(0);
		expect(resolveExecuteTimeoutMs(-3600)).toBe(0);
	});

	it("treats non-finite values as disabled instead of scheduling an invalid timer", () => {
		expect(resolveExecuteTimeoutMs(Number.NaN)).toBe(0);
		expect(resolveExecuteTimeoutMs(Number.POSITIVE_INFINITY)).toBe(0);
	});
});
