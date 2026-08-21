import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

describe("MutationDrainLatch", () => {
	it("reports drain state synchronously with an optional remaining allowance", () => {
		const latch = new MutationDrainLatch();
		expect(latch.isDrained()).toBe(true);

		latch.begin();
		expect(latch.isDrained()).toBe(false);
		expect(latch.isDrained(1)).toBe(true);

		latch.end();
		expect(latch.isDrained()).toBe(true);
	});

	it("rejects an already-aborted wait even when no mutations are active", async () => {
		const latch = new MutationDrainLatch();
		const controller = new AbortController();
		controller.abort();
		const addEventListener = vi.spyOn(controller.signal, "addEventListener");

		await expect(latch.waitForDrain(0, controller.signal, "drain cancelled")).rejects.toThrow("drain cancelled");
		expect(addEventListener).not.toHaveBeenCalled();
	});

	it("keeps abort terminal when draining and aborting concurrently without leaking its listener", async () => {
		const latch = new MutationDrainLatch();
		const controller = new AbortController();
		const addEventListener = vi.spyOn(controller.signal, "addEventListener");
		const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
		latch.begin();

		const drained = latch.waitForDrain(0, controller.signal, "drain cancelled");
		latch.end();
		controller.abort();

		await expect(drained).rejects.toThrow("drain cancelled");
		expect(addEventListener).toHaveBeenCalledOnce();
		expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledOnce();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
