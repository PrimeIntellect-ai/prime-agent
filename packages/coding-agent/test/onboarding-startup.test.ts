import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { type OnboardingStartupState, shouldRunOnboarding } from "../src/modes/interactive/onboarding.js";

function makeModel(provider: string): Model<Api> {
	return { id: "test-model", provider } as Model<Api>;
}

function makeState(overrides: {
	onboardingShown: boolean;
	model: Model<Api> | undefined;
	modelHasAuth?: boolean;
}): OnboardingStartupState {
	return {
		settingsManager: {
			getOnboardingShown: () => overrides.onboardingShown,
		},
		modelRegistry: {
			refresh: () => {},
			hasConfiguredAuth: () => overrides.modelHasAuth ?? false,
		},
		model: overrides.model,
	};
}

describe("startup onboarding decision", () => {
	test("runs on a first launch, including when credentials are already on disk", () => {
		expect(shouldRunOnboarding(makeState({ onboardingShown: false, model: undefined }))).toBe(true);
		expect(
			shouldRunOnboarding(
				makeState({ onboardingShown: false, model: makeModel(PRIME_INFERENCE_PROVIDER_ID), modelHasAuth: true }),
			),
		).toBe(true);
	});

	test("never reopens once the flag is set", () => {
		expect(shouldRunOnboarding(makeState({ onboardingShown: true, model: undefined }))).toBe(false);
		expect(
			shouldRunOnboarding(makeState({ onboardingShown: true, model: makeModel("anthropic"), modelHasAuth: true })),
		).toBe(false);
	});
});
