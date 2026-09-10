import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoRefinement } from "../../../src/session/auto-refinement.js";
import type { SessionRefinement, SessionRefinementHost } from "../../../src/session/refinement.js";
import { createHarness, type Harness } from "../harness.js";
import { withStreaming } from "../scheduling.js";

type RefinementInternals = Pick<SessionRefinement, keyof SessionRefinement> & {
	_auto: AutoRefinement;
	_host: SessionRefinementHost;
};
function owner(harness: Harness): RefinementInternals {
	return (harness.session as unknown as { _refinement: RefinementInternals })._refinement;
}

describe("refinement public dispatch preservation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	for (const source of ["self", "auto"] as const) {
		it(`dispatches ${source} refinement through a live public wrapper before planning`, async () => {
			const order: string[] = [];
			const harness = await createHarness({
				persistSession: true,
				autoRefineReviewer: async () => {
					order.push("review");
					return { shouldRefine: true, rationale: "test" };
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_refine", () => {
							order.push("plan");
							return { proposal: { summary: "test", rationale: "test", expectedOutcome: "test", edits: [] } };
						});
					},
				],
			});
			harnesses.push(harness);
			const refinement = owner(harness);
			vi.spyOn(harness.settingsManager, "getAutoRefineSettings").mockReturnValue({
				...harness.settingsManager.getAutoRefineSettings(),
				enabled: true,
				turnInterval: 1,
			});
			const original = harness.session.refine.bind(harness.session);
			const wrapper = vi.spyOn(harness.session, "refine").mockImplementation((options, internal) => {
				order.push("wrapper");
				if (source === "self") expect(refinement._consumePendingRequestedRefine()).toBe(false);
				return original(options, internal);
			});
			if (source === "self") {
				withStreaming(harness, true);
				harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
				withStreaming(harness, false);
				expect(refinement._consumePendingRequestedRefine()).toBe(true);
			} else {
				refinement._auto.observeAssistantEnd();
				await refinement._auto._maybeAutoRefine("turn_interval");
			}
			expect(wrapper).toHaveBeenCalledOnce();
			await wrapper.mock.results[0].value;
			expect(wrapper.mock.calls[0][1]).toEqual(source === "self" ? { source: "self" } : { trigger: "auto" });
			expect(order).toEqual(source === "self" ? ["wrapper", "plan"] : ["review", "wrapper", "plan"]);
		});

		it(`preserves ${source} public wrapper rejection handling`, async () => {
			const harness = await createHarness({
				persistSession: true,
				autoRefineReviewer: async () => ({ shouldRefine: true, rationale: "test" }),
			});
			harnesses.push(harness);
			const refinement = owner(harness);
			vi.spyOn(harness.settingsManager, "getAutoRefineSettings").mockReturnValue({
				...harness.settingsManager.getAutoRefineSettings(),
				enabled: true,
				turnInterval: 1,
			});
			const failure = new Error("public wrapper rejected");
			const wrapper = vi.spyOn(harness.session, "refine").mockRejectedValue(failure);
			const emit = vi.spyOn(refinement._host, "emit");
			if (source === "self") {
				withStreaming(harness, true);
				harness.session.handleRefineHostRequest("refine.run", {});
				withStreaming(harness, false);
				expect(refinement._consumePendingRequestedRefine()).toBe(true);
				await Promise.resolve();
				expect(emit).toHaveBeenCalledWith({ type: "refine_failed", error: failure.message });
				expect(refinement._consumePendingRequestedRefine()).toBe(false);
			} else {
				refinement._auto.observeAssistantEnd();
				await expect(refinement._auto._maybeAutoRefine("turn_interval")).resolves.toBeUndefined();
				expect(refinement._auto.lastReviewAt).toBeGreaterThan(0);
				expect(refinement._auto.turnsSinceReview).toBe(1);
				expect(emit).not.toHaveBeenCalled();
			}
			expect(wrapper).toHaveBeenCalledOnce();
		});
	}

	it("settles the default no-model review before the next queued microtask", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refinement = owner(harness);
		vi.spyOn(refinement._host, "getModel").mockReturnValue(undefined);
		const order: string[] = [];
		const review = refinement._auto._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 1 });
		void review.then(() => order.push("review"));
		queueMicrotask(() => order.push("microtask"));
		await expect(review).resolves.toEqual({ shouldRefine: false, rationale: "No model selected." });
		expect(order).toEqual(["review", "microtask"]);
	});

	it("preserves the custom reviewer's async promise adoption", async () => {
		const result = { shouldRefine: false, rationale: "custom decline" };
		const inner = Promise.resolve(result);
		const reviewer = vi.fn(() => inner);
		const harness = await createHarness({ autoRefineReviewer: reviewer });
		harnesses.push(harness);
		const order: string[] = [];
		const review = owner(harness)._auto._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 1 });
		expect(reviewer).toHaveBeenCalledOnce();
		expect(review).not.toBe(inner);
		void review.then(() => order.push("review"));
		queueMicrotask(() => order.push("microtask"));
		await expect(review).resolves.toEqual(result);
		expect(order).toEqual(["microtask", "review"]);
	});

	it("turns synchronous custom reviewer throws into promise rejections", async () => {
		const failure = new Error("review failed");
		const harness = await createHarness({
			autoRefineReviewer: () => {
				throw failure;
			},
		});
		harnesses.push(harness);
		const review = owner(harness)._auto._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 1 });
		await expect(review).rejects.toBe(failure);
	});
});
