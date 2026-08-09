import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

type SessionContinuationInternals = {
	_schedulePostCompactionContinue(): void;
	_cancelPostCompactionContinue(): void;
	_postCompactionContinuationScheduled: boolean;
};

describe("issue #674 headless completion must not race the post-compaction continuation", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("waitForIdle waits for a scheduled continuation instead of resolving into teardown", async () => {
		const internals = harness.session as unknown as SessionContinuationInternals;
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);

		internals._schedulePostCompactionContinue();
		expect(internals._postCompactionContinuationScheduled).toBe(true);

		await harness.session.waitForIdle();

		expect(internals._postCompactionContinuationScheduled).toBe(false);
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("waitForIdle resolves when a scheduled continuation is cancelled", async () => {
		const internals = harness.session as unknown as SessionContinuationInternals;
		internals._schedulePostCompactionContinue();

		const idle = harness.session.waitForIdle();
		internals._cancelPostCompactionContinue();

		await expect(
			Promise.race([idle.then(() => "idle"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000))]),
		).resolves.toBe("idle");
	});
});
