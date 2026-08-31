import { afterEach, describe, expect, it, vi } from "vitest";
import { REFINEMENT_DISPOSAL_GRACE_MS, SESSION_DISPOSAL_TIMEOUT_MS } from "../../../src/core/agent-session.js";
import { createHarness, type Harness } from "../harness.js";

type DisposalInternals = {
	_disposed: boolean;
	_maybeStartSerializedBackgroundPlan(): void;
	_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
};

describe("issue #5: bounded refinement disposal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("aborts and abandons a refinement that ignores cancellation after the grace period", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as DisposalInternals;
		let refinementSignal: AbortSignal | undefined;
		vi.spyOn(internals, "_planRefine").mockImplementation((_options, signal) => {
			refinementSignal = signal;
			return new Promise<never>(() => undefined);
		});

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "never settle" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		internals._maybeStartSerializedBackgroundPlan();
		expect(refinementSignal?.aborted).toBe(false);

		vi.useFakeTimers();
		let disposed = false;
		const disposal = harness.session.disposeAsync().then(() => {
			disposed = true;
		});
		await vi.advanceTimersByTimeAsync(REFINEMENT_DISPOSAL_GRACE_MS - 1);
		expect(disposed).toBe(false);
		expect(refinementSignal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await disposal;
		expect(refinementSignal?.aborted).toBe(true);
		expect(disposed).toBe(true);
		expect(internals._disposed).toBe(true);
	});

	it("rejects within the documented hard bound when asynchronous teardown never settles", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerDisposeCallback(() => new Promise<never>(() => undefined));

		vi.useFakeTimers();
		const disposal = harness.session.disposeAsync();
		const rejection = expect(disposal).rejects.toThrow(`Session disposal exceeded ${SESSION_DISPOSAL_TIMEOUT_MS}ms`);
		await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_TIMEOUT_MS);
		await rejection;
		expect((harness.session as unknown as DisposalInternals)._disposed).toBe(true);
	});
});
