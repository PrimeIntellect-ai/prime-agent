import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefinementPlan, RefinementResult } from "../../src/core/refinement/index.js";
import type { AutoRefinement } from "../../src/session/refinement/auto-refinement.js";
import type {
	SerializedBackgroundPlanResult,
	SessionRefinement,
	SessionRefinementHost,
} from "../../src/session/refinement/refinement.js";
import type { RefinementExecution } from "../../src/session/refinement/refinement-execution.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred, withStreaming } from "./scheduling.js";

type RefinementInternals = Pick<SessionRefinement, keyof SessionRefinement> & {
	_host: SessionRefinementHost;
	_auto: AutoRefinement;
	_execution: RefinementExecution;
	_serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
};

function owner(harness: Harness): RefinementInternals {
	return (harness.session as unknown as { _refinement: RefinementInternals })._refinement;
}

function plan(): RefinementPlan {
	return {
		id: "owner-plan",
		proposal: { summary: "owner test", rationale: "test", expectedOutcome: "test", edits: [] },
	};
}

function result(): RefinementResult {
	return {
		id: "owner-result",
		summary: "test",
		rationale: "test",
		expectedOutcome: "test",
		appliedEdits: [],
		harnessStatePath: "/tmp/owner-state.json",
	};
}

describe("SessionRefinement ownership boundary", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("preserves the owner's public promise and synchronous host-request errors", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refinement = owner(harness);
		const gate = createDeferred<RefinementResult>();
		const refine = vi.spyOn(refinement, "refine").mockReturnValue(gate.promise);
		expect(harness.session.refine({ instructions: "capture" })).toBe(gate.promise);
		expect(refine).toHaveBeenCalledWith({ instructions: "capture" }, {});
		expect(() => harness.session.handleRefineHostRequest("refine.run", { instructions: 1 })).toThrow(
			"refine.run instructions must be a string",
		);
		gate.resolve(result());
		await gate.promise;
	});

	it("invalidates before abort and returns the exact plan for caller-owned cleanup settlement", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const refinement = owner(harness);
		expect(refinement.beginAbortedTurnCleanup()).toBeUndefined();
		const planning = createDeferred<RefinementPlan>();
		let versionAtAbort: number | undefined;
		const initialVersion = refinement._auto.branchVersion;
		vi.spyOn(refinement._execution, "_planRefine").mockImplementation((_options, signal) => {
			signal.addEventListener("abort", () => {
				versionAtAbort = refinement._auto.branchVersion;
			});
			return planning.promise;
		});
		withStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "original" });
		withStreaming(harness, false);
		const original = refinement._serializedPlanInFlight;
		const cleanup = refinement.beginAbortedTurnCleanup();
		expect(cleanup?.promise).toBe(original);
		expect(versionAtAbort).toBe(initialVersion + 1);
		expect(refinement._serializedPlanInFlight).toBe(original);
		planning.resolve(plan());
		await expect(cleanup?.promise).resolves.toEqual({ status: "invalidated", branchVersion: initialVersion });
		const replacement = Promise.resolve<SerializedBackgroundPlanResult>({ status: "skip" });
		refinement._serializedPlanInFlight = replacement;
		cleanup?.finish();
		expect(refinement._serializedPlanInFlight).toBe(replacement);
		refinement._serializedPlanInFlight = undefined;
	});

	it("keeps planning nonblocking and rechecks operations added while waiting to apply", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const refinement = owner(harness);
		const planning = createDeferred<RefinementPlan>();
		const firstOperation = createDeferred();
		const secondOperation = createDeferred();
		let operation = firstOperation.promise;
		vi.spyOn(refinement._host, "getCompactionOperation").mockImplementation(() => operation);
		vi.spyOn(refinement._execution, "_planRefine").mockReturnValue(planning.promise);
		const apply = vi.spyOn(refinement._execution, "_applyRefine").mockResolvedValue(result());
		const run = harness.session.refine();
		expect(refinement.isApplying).toBe(false);
		expect(harness.session.handleRefineHostRequest("refine.status").in_flight).toBe(true);
		planning.resolve(plan());
		await vi.waitFor(() => expect(refinement.isApplying).toBe(true));
		operation = secondOperation.promise;
		firstOperation.resolve();
		await new Promise<void>(setImmediate);
		expect(apply).not.toHaveBeenCalled();
		secondOperation.resolve();
		await run;
		expect(apply).toHaveBeenCalledOnce();
		expect(refinement.isApplying).toBe(false);
	});

	it("reads the current model, auth resolver, and extension runner for each plan", async () => {
		const firstHook = vi.fn(() => ({ proposal: plan().proposal }));
		const secondHook = vi.fn(() => ({ proposal: { ...plan().proposal, summary: "replacement runner" } }));
		const first = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", firstHook);
				},
			],
		});
		const second = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", secondHook);
				},
			],
		});
		harnesses.push(first, second);
		const refinement = owner(first);
		const firstModel = first.getModel();
		const secondModel = { ...firstModel, id: "replacement-model" };
		const getModel = vi.spyOn(refinement._host, "getModel").mockReturnValue(firstModel);
		const getAuth = vi.spyOn(refinement._host, "getRequiredRequestAuth").mockResolvedValue({ apiKey: "test-first" });
		await first.session.refine();
		expect(firstHook).toHaveBeenCalledOnce();
		expect(getAuth).toHaveBeenLastCalledWith(firstModel);
		getModel.mockReturnValue(secondModel);
		getAuth.mockResolvedValue({ apiKey: "test-replacement" });
		vi.spyOn(refinement._host, "getExtensionRunner").mockReturnValue(owner(second)._host.getExtensionRunner());
		const applied = await first.session.refine();
		expect(applied.summary).toBe("replacement runner");
		expect(getAuth).toHaveBeenLastCalledWith(secondModel);
		expect(firstHook).toHaveBeenCalledOnce();
		expect(secondHook).toHaveBeenCalledOnce();
	});

	it("preserves audit failure precedence over outcome publication and still reconnects", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const refinement = owner(harness);
		vi.spyOn(refinement._execution, "_planRefine").mockResolvedValue(plan());
		const auditError = new Error("audit append failed");
		vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
			throw auditError;
		});
		vi.spyOn(refinement._host, "emit").mockImplementation((event) => {
			if (event.type === "message_start") throw new Error("outcome listener failed");
		});
		const reconnect = vi.spyOn(refinement._host, "reconnect");
		await expect(harness.session.refine()).rejects.toBe(auditError);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "refinement_outcome" }),
		);
		expect(reconnect).toHaveBeenCalledOnce();
		expect(refinement.isApplying).toBe(false);
	});
});
