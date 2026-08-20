import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowShell } from "../../src/core/workflow/shell.js";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_consumePendingRequestedRefine: () => boolean;
	_emitRefineFailed: (error: unknown) => void;
	_pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;
	_serializedPlanInFlight?: Promise<unknown>;
	_serializedExplicitRefineOptions?: { instructions?: string; global?: boolean };
	_refineAbortController?: AbortController;
	_createKernelHostHandlers: () => Record<string, unknown>;
	_planRefine: (...args: unknown[]) => Promise<unknown>;
	_runSerializedRefine: (...args: unknown[]) => Promise<void>;
	_runSerializedRefineCheckpoint: () => Promise<void>;
	_maybeAutoRefine: (...args: unknown[]) => Promise<void>;
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

	it("keeps workflow-owned nonauthoritative findings out of durable refinement", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: {
				autoRefine: { enabled: true, compact: true, turnInterval: 1, cooldownMs: 0 },
				compaction: { keepRecentTokens: 1 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "workflow-owned compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const workflowHost: WorkflowShell = {
			execute: async () => workflowHost.status(),
			status: () => ({
				workflowId: harness.session.sessionId,
				status: "paused",
				phase: "recovering",
				goal: harness.session.goalState,
				goalContract: null,
				approvalRequest: null,
				stateDigest: "paused-nonauthoritative-state",
				decisionRefs: [],
				resourceEnvelopeDigest: null,
				scorecardDigest: null,
				acceptanceCheckIds: [],
				protectedInvariantIds: [],
				pendingWaitReasons: [{ code: "nonauthoritative_evidence" }],
			}),
		};
		harness.session.setWorkflowHost(workflowHost);
		const workflowHandlers = (harness.session as unknown as SessionInternals)._createKernelHostHandlers();
		expect(Object.keys(workflowHandlers)).toContain("refine.run");

		setStreaming(harness, true);
		const result = harness.session.handleRefineHostRequest("refine.run", {
			instructions: "promote NONAUTHORITATIVE_RECON_ONLY checkpoint",
			global: true,
		});
		setStreaming(harness, false);

		expect(result).toMatchObject({
			scheduled: false,
			status: "rejected",
			code: "nonauthoritative_refinement_rejected",
			reason: expect.stringContaining("authenticated learning promotion receipt"),
		});
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
		await expect(
			harness.session.refine({ instructions: "promote NONAUTHORITATIVE_RECON_ONLY checkpoint", global: true }),
		).rejects.toMatchObject({
			code: "nonauthoritative_refinement_rejected",
			message: expect.stringContaining("authenticated learning promotion receipt"),
		});

		const internals = harness.session as unknown as SessionInternals;
		const planRefine = vi.spyOn(internals, "_planRefine");
		const runSerializedRefine = vi.spyOn(internals, "_runSerializedRefine");
		const maybeAutoRefine = vi.spyOn(internals, "_maybeAutoRefine");
		internals._pendingRequestedRefine = { instructions: "must not plan" };
		await expect(internals._runSerializedRefine({ instructions: "must not plan" })).rejects.toMatchObject({
			code: "nonauthoritative_refinement_rejected",
		});
		await expect(internals._runSerializedRefineCheckpoint()).rejects.toMatchObject({
			code: "nonauthoritative_refinement_rejected",
		});
		await expect(internals._maybeAutoRefine("turn_interval")).rejects.toMatchObject({
			code: "nonauthoritative_refinement_rejected",
		});
		expect(internals._consumePendingRequestedRefine()).toBe(false);
		expect(planRefine).not.toHaveBeenCalled();
		expect(runSerializedRefine).toHaveBeenCalledTimes(1);
		expect(maybeAutoRefine).toHaveBeenCalledTimes(1);

		await harness.session.compact();
		const harnessStatePath = join(
			harness.session.sessionManager.getSessionArtifactDir()!,
			"harness",
			"harness_state.json",
		);
		expect(existsSync(harnessStatePath)).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "prime-agent.refinement"),
		).toBe(false);
	});

	it("routes an authenticated learning promotion through the host authority exactly once", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const consumeAndApply = vi.fn().mockResolvedValue({
			applicationId: "application-1",
			appliedBytesDigest: "a".repeat(64),
			previousBytesDigest: null,
			rollbackToken: "rollback-1",
		});
		harness.session.setWorkflowHost({
			execute: async () => {
				throw new Error("not used");
			},
			status: () =>
				({ status: "active", workflowId: harness.session.sessionId, stateDigest: "workflow-head" }) as never,
			learningPromotionReceipts: { consumeAndApply } as never,
		} as never);

		const input = { receipt: { receiptId: "receipt-1" }, refinement: { action: "create" } };
		await expect(harness.session.applyWorkflowLearningPromotionRefinement(input as never)).resolves.toMatchObject({
			applicationId: "application-1",
		});
		expect(consumeAndApply).toHaveBeenCalledTimes(1);
		expect(consumeAndApply).toHaveBeenCalledWith(input);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "prime-agent.refinement"),
		).toBe(false);
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
