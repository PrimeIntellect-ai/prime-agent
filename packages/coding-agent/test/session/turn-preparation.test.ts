import { describe, expect, it } from "vitest";
import {
	createTurnExecutionPolicy,
	type TurnPreparationHost,
	TurnPreparer,
} from "../../src/session/turn-preparation.js";

function createPreparation(overrides: Partial<TurnPreparationHost> = {}) {
	const order: string[] = [];
	const preparer = new TurnPreparer({
		hasRefinement: () => false,
		waitForRefinement: async () => {
			order.push("refine");
		},
		flushPendingBash: () => {
			order.push("flush");
		},
		validate: async () => {
			order.push("validate");
		},
		compact: async () => {
			order.push("compact");
		},
		pendingModelSelection: () => {
			order.push("model");
			return Promise.resolve();
		},
		...overrides,
	});
	const steps = {
		afterValidation: () => {
			order.push("after validation");
		},
		prepare: async () => {
			order.push("prepare");
			return "prepared";
		},
		beforeFinalRefineBarrier: () => {
			order.push("before barrier");
		},
		commit: (value: string, passedBarrier: boolean) => {
			order.push(`commit:${passedBarrier}`);
			return value;
		},
	};
	return { preparer, order, steps };
}

describe("TurnPreparer", () => {
	it.each([
		{
			kind: "queued",
			order: [
				"validate",
				"after validation",
				"flush",
				"compact",
				"model",
				"prepare",
				"before barrier",
				"refine",
				"commit:true",
			],
		},
		{
			kind: "directPrompt",
			order: [
				"refine",
				"flush",
				"validate",
				"after validation",
				"model",
				"compact",
				"prepare",
				"before barrier",
				"commit:false",
			],
		},
		{
			kind: "injected",
			order: [
				"refine",
				"flush",
				"validate",
				"after validation",
				"compact",
				"model",
				"prepare",
				"before barrier",
				"commit:false",
			],
		},
		{
			kind: "customTrigger",
			order: ["refine", "after validation", "flush", "prepare", "before barrier", "commit:false"],
		},
	] as const)("preserves $kind preparation order", async ({ kind, order: expected }) => {
		const { preparer, order, steps } = createPreparation();
		expect(await preparer.prepare(createTurnExecutionPolicy(kind).preparation, steps)).toBe("prepared");
		expect(order).toEqual(expected);
	});

	it("rechecks conditional refinement after preparation and before commit", async () => {
		let refining = false;
		const { preparer, order, steps } = createPreparation({ hasRefinement: () => refining });
		await preparer.prepare(createTurnExecutionPolicy("directPrompt", { returnAfterAccepted: true }).preparation, {
			...steps,
			beforeFinalRefineBarrier: () => {
				refining = true;
			},
		});
		expect(order).toEqual([
			"flush",
			"validate",
			"after validation",
			"model",
			"compact",
			"prepare",
			"refine",
			"commit:true",
		]);
	});

	it("skips the final barrier and commit when preparation was withdrawn", async () => {
		const { preparer, order, steps } = createPreparation();
		const committed = await preparer.prepare(createTurnExecutionPolicy("queued").preparation, {
			...steps,
			shouldCommit: () => false,
		});
		expect(committed).toBeUndefined();
		expect(order).toEqual(["validate", "after validation", "flush", "compact", "model", "prepare"]);
	});

	it.each(["queued", "directPrompt"] as const)("retains the %s flush boundary when validation fails", async (kind) => {
		const { preparer, order, steps } = createPreparation({
			validate: async () => {
				throw new Error("auth failed");
			},
		});
		await expect(preparer.prepare(createTurnExecutionPolicy(kind).preparation, steps)).rejects.toThrow("auth failed");
		expect(order).toEqual(kind === "queued" ? [] : ["refine", "flush"]);
	});

	it("does not prepare or compact after pending model selection rejects on a direct prompt", async () => {
		const { preparer, order, steps } = createPreparation({
			pendingModelSelection: () => Promise.reject(new Error("selection failed")),
		});
		await expect(preparer.prepare(createTurnExecutionPolicy("directPrompt").preparation, steps)).rejects.toThrow(
			"selection failed",
		);
		expect(order).toEqual(["refine", "flush", "validate", "after validation"]);
	});

	it("awaits the final refinement barrier before committing the prepared value", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { preparer, order, steps } = createPreparation({ waitForRefinement: () => gate });
		const preparation = preparer.prepare(createTurnExecutionPolicy("queued").preparation, steps);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order.at(-1)).toBe("before barrier");
		release();
		expect(await preparation).toBe("prepared");
		expect(order.at(-1)).toBe("commit:true");
	});
});
