import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_STREAM_STALL_TIMEOUT_MS,
	readWithStallTimeout,
	resolveStallTimeoutMs,
	StreamStallError,
} from "../src/utils/stream-stall.js";

describe("resolveStallTimeoutMs", () => {
	it("defaults to five minutes when unset", () => {
		expect(resolveStallTimeoutMs(undefined)).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
		expect(DEFAULT_STREAM_STALL_TIMEOUT_MS).toBe(300_000);
	});

	it("uses a configured budget", () => {
		expect(resolveStallTimeoutMs(30_000)).toBe(30_000);
	});

	// 0 is the documented opt-out, so it must mean unbounded and never "fail instantly".
	it("treats zero, negative, and non-finite values as disabled", () => {
		expect(resolveStallTimeoutMs(0)).toBe(0);
		expect(resolveStallTimeoutMs(-1)).toBe(0);
		expect(resolveStallTimeoutMs(Number.NaN)).toBe(0);
		expect(resolveStallTimeoutMs(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("readWithStallTimeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the value when the read completes in time", async () => {
		await expect(readWithStallTimeout(async () => "chunk", 1_000)).resolves.toBe("chunk");
	});

	it("rejects with a stall error when the read produces nothing in time", async () => {
		vi.useFakeTimers();
		const pending = readWithStallTimeout(() => new Promise<string>(() => {}), 5_000);
		const assertion = expect(pending).rejects.toBeInstanceOf(StreamStallError);
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
	});

	it("names the budget so the failure is legible in a transcript", async () => {
		vi.useFakeTimers();
		const pending = readWithStallTimeout(() => new Promise<string>(() => {}), 300_000);
		const assertion = expect(pending).rejects.toThrow("sent no data for 300s");
		await vi.advanceTimersByTimeAsync(300_000);
		await assertion;
	});

	it("never arms a timer when disabled", async () => {
		vi.useFakeTimers();
		let settled = false;
		void readWithStallTimeout(() => new Promise<string>(() => {}), 0).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(settled).toBe(false);
	});

	it("arms the budget per read, so a slow but progressing stream is not cut off", async () => {
		vi.useFakeTimers();
		let reads = 0;
		const read = () =>
			new Promise<string>((resolve) => {
				reads += 1;
				globalThis.setTimeout(() => resolve(`chunk-${reads}`), 4_000);
			});

		for (let i = 0; i < 3; i++) {
			const pending = readWithStallTimeout(read, 5_000);
			await vi.advanceTimersByTimeAsync(4_000);
			await expect(pending).resolves.toBe(`chunk-${i + 1}`);
		}
		expect(reads).toBe(3);
	});
});
