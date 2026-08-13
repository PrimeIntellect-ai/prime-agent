import { describe, expect, it } from "vitest";
import {
	AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS,
	autoRefineReviewMaxOutputTokens,
	REFINEMENT_MAX_OUTPUT_TOKENS,
	refinementMaxOutputTokens,
} from "../src/core/refinement/refinement.js";

describe("refinement output token budgets", () => {
	it("uses the policy cap when the model has no published output limit", () => {
		expect(refinementMaxOutputTokens({ maxTokens: 0 })).toBe(REFINEMENT_MAX_OUTPUT_TOKENS);
		expect(autoRefineReviewMaxOutputTokens({ maxTokens: 0 })).toBe(AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
	});

	it("still clamps models with a published output limit", () => {
		expect(refinementMaxOutputTokens({ maxTokens: 8_000 })).toBe(8_000);
		expect(refinementMaxOutputTokens({ maxTokens: 80_000 })).toBe(REFINEMENT_MAX_OUTPUT_TOKENS);
		expect(autoRefineReviewMaxOutputTokens({ maxTokens: 2_000 })).toBe(2_000);
		expect(autoRefineReviewMaxOutputTokens({ maxTokens: 8_000 })).toBe(AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
	});
});
