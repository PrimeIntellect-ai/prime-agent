import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	WORKER_MODEL_ID,
	WORKER_MODEL_IDS,
	WORKER_MODEL_REASONING,
	WORKER_MODEL_REASONING_BY_ID,
	workerModelReasoningFor,
} from "../src/core/workflow/worker-model-capability-gate.js";

describe("per-model worker reasoning", () => {
	it("runs the deep tier at high and the cheap tier at max", () => {
		expect(workerModelReasoningFor("gpt-5.6-sol")).toBe("high");
		expect(workerModelReasoningFor("gpt-5.6-luna")).toBe("max");
	});

	it("has no level for a model the host does not admit", () => {
		expect(workerModelReasoningFor("gpt-4o-mini")).toBeUndefined();
	});

	it("declares a level for every admitted model, so no tier falls back silently", () => {
		for (const id of WORKER_MODEL_IDS) expect(workerModelReasoningFor(id)).toBeTypeOf("string");
		expect(Object.keys(WORKER_MODEL_REASONING_BY_ID).sort()).toEqual([...WORKER_MODEL_IDS].sort());
	});

	it("keeps the default constant consistent with the table", () => {
		expect(WORKER_MODEL_REASONING).toBe(workerModelReasoningFor(WORKER_MODEL_ID));
	});

	it("declares only levels the model itself offers, so the receipt cannot outrank the run", () => {
		// sol's thinkingLevelMap lists only minimal/xhigh/max, which reads as though "high" were
		// unsupported and would clamp - it is not, because the map needs explicit entries only for
		// xhigh and max. Reading the map is misleading, so assert against the catalog instead: a
		// declared level must be supported AND survive clamping, or the receipt would attest an
		// effort the child never ran at.
		for (const id of WORKER_MODEL_IDS) {
			const model = getModel("openai-codex", id as never);
			expect(model, `missing catalog entry for openai-codex/${id}`).toBeDefined();
			const declared = workerModelReasoningFor(id);
			expect(declared).toBeDefined();
			expect(getSupportedThinkingLevels(model as never)).toContain(declared);
			// Nothing is clamped away: what is attested is what runs.
			expect(clampThinkingLevel(model as never, declared as never)).toBe(declared);
		}
	});
});
