import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_consumePendingRequestedRefine: () => boolean;
	_emitRefineFailed: (error: unknown) => void;
	_pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;
	_serializedPlanInFlight?: Promise<unknown>;
	_serializedExplicitRefineOptions?: { instructions?: string; global?: boolean };
	_refineAbortController?: AbortController;
	_createKernelHostHandlers: () => Record<string, unknown>;
	refine: (options: { instructions?: string; global?: boolean }) => Promise<unknown>;
};

function setStreaming(harness: Harness, streaming: boolean) {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = streaming;
}

describe("AgentSession refine skill host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("schedules via refine.run and reports pending via refine.status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		const runResult = harness.session.handleRefineHostRequest("refine.run", { instructions: "test instructions" });
		setStreaming(harness, false);
		expect(runResult.scheduled).toBe(true);
		expect(runResult.note).toBeDefined();

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.pending).toBe(true);
	});

	it("stores global flag from refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { global: true });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.global).toBe(true);
	});

	it("defaults to local scope when global is not provided", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run");
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.global).toBeUndefined();
		expect(internals._pendingRequestedRefine?.instructions).toBeUndefined();
	});

	it("updates pending request when called again", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "first", global: true });
		harness.session.handleRefineHostRequest("refine.run", { instructions: "second" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.instructions).toBe("second");
		expect(internals._pendingRequestedRefine?.global).toBe(true);
	});

	it("replaces an in-flight serialized plan instead of applying both requests", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const abort = new AbortController();
		internals._serializedPlanInFlight = new Promise(() => {});
		internals._serializedExplicitRefineOptions = { instructions: "first", global: true };
		internals._refineAbortController = abort;

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "replacement" });
		setStreaming(harness, false);

		expect(abort.signal.aborted).toBe(true);
		expect(internals._pendingRequestedRefine).toEqual({ instructions: "replacement", global: true });
	});

	it("discards a settled serialized plan when a replacement request arrives", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		internals._serializedPlanInFlight = Promise.resolve({ status: "plan" });
		internals._serializedExplicitRefineOptions = { instructions: "first", global: true };

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "replacement" });
		setStreaming(harness, false);

		await expect(internals._serializedPlanInFlight).resolves.toEqual({
			status: "invalidated",
			branchVersion: expect.any(Number),
		});
		expect(internals._pendingRequestedRefine).toEqual({ instructions: "replacement", global: true });
	});

	it("rejects refine.run while no turn is active", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = harness.session.handleRefineHostRequest("refine.run");
		expect(result.scheduled).toBe(false);
		expect(result.reason).toContain("no active turn");
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
	});

	it("validates instructions type in refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		expect(() =>
			harness.session.handleRefineHostRequest("refine.run", { instructions: 123 as unknown as string }),
		).toThrow("instructions must be a string");
		setStreaming(harness, false);
	});

	it("validates global flag type in refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		expect(() =>
			harness.session.handleRefineHostRequest("refine.run", { global: "yes" as unknown as boolean }),
		).toThrow("global must be a boolean");
		setStreaming(harness, false);
	});

	it("reports in_flight as false when no refine is active", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.in_flight).toBe(false);
		expect(status.pending).toBe(false);
	});

	it("consumes pending refine request at turn boundary", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		const refineSpy = vi.spyOn(internals, "refine").mockResolvedValue({});
		internals._consumePendingRequestedRefine();
		expect(refineSpy).toHaveBeenCalledWith({ instructions: "test", global: undefined });
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("does nothing when no pending refine at turn boundary", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const refineSpy = vi.spyOn(internals, "refine").mockResolvedValue({});
		expect(internals._consumePendingRequestedRefine()).toBe(false);
		expect(refineSpy).not.toHaveBeenCalled();
	});

	it("catches errors from refine at turn boundary without throwing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "refine").mockRejectedValue(new Error("refine failed"));
		const failed = new Promise<string>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "refine_failed") {
					unsubscribe();
					resolve(event.error);
				}
			});
		});

		expect(internals._consumePendingRequestedRefine()).toBe(true);
		expect(await failed).toBe("refine failed");
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("continues notifying refine listeners after one throws", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const observed: string[] = [];
		harness.session.subscribe(() => {
			throw new Error("broken listener");
		});
		harness.session.subscribe((event) => {
			if (event.type === "refine_failed") {
				observed.push(event.error);
			}
		});

		expect(() => internals._emitRefineFailed(new Error("planning failed"))).not.toThrow();
		expect(observed).toEqual(["planning failed"]);
	});

	it("registers refine.run and refine.status handlers when auto-refine is allowed", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).toEqual(expect.arrayContaining(["refine.run", "refine.status"]));
	});

	it("does not register refine handlers when auto-refine is not allowed (rlmDepth > 0)", async () => {
		const harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).not.toContain("refine.run");
		expect(handlerKeys).not.toContain("refine.status");
	});

	it("does not register refine handlers without a persisted session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).not.toContain("refine.run");
		expect(handlerKeys).not.toContain("refine.status");
	});

	it("clears pending refine on dispose", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(true);
		harness.session.dispose();
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
	});

	it("rejects unknown refine request type", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		expect(() => harness.session.handleRefineHostRequest("refine.unknown")).toThrow(
			'unknown refine request type "refine.unknown"',
		);
	});
});
