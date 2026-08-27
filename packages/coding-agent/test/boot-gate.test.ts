import { afterEach, describe, expect, it } from "vitest";
import { resolveKernelBootConcurrency } from "../src/core/kernel/boot-gate.js";

const ENV = "PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS";

describe("resolveKernelBootConcurrency", () => {
	afterEach(() => {
		delete process.env[ENV];
	});

	it("never returns a value below 1 (so the semaphore can't throw at load)", () => {
		for (const bad of ["0", "00", "000", "abc", "3.9", "-1", "8 junk", ""]) {
			process.env[ENV] = bad;
			expect(resolveKernelBootConcurrency()).toBeGreaterThanOrEqual(1);
		}
	});

	it("honors a clean positive integer, clamped to the max", () => {
		process.env[ENV] = "8";
		expect(resolveKernelBootConcurrency()).toBe(8);
		process.env[ENV] = "999999";
		expect(resolveKernelBootConcurrency()).toBe(64);
	});
});
