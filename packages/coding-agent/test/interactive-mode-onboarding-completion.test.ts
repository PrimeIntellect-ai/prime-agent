import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { OnboardingStartupState } from "../src/modes/interactive/onboarding.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Context = Record<string, unknown> & {
	settingsManager: {
		getOnboardingShown: () => boolean;
		setOnboardingShown: (shown: boolean) => void;
		flush: () => Promise<void>;
	};
};

type Prototype = {
	runStartupOnboarding(this: Context): Promise<boolean>;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function makeContext(options: { modelReady: boolean }): Context {
	const shown = { value: false };
	const context: Context = {
		settingsManager: {
			getOnboardingShown: () => shown.value,
			setOnboardingShown: (value: boolean) => {
				shown.value = value;
			},
			flush: vi.fn(async () => {}),
		},
		shouldRunOnboarding: () => true,
		shouldRunPrimeCliOnboardingSplash: () => false,
		runOnboardingFlow: vi.fn(async () => {}),
		markOnboardingShown: InteractiveMode.prototype[
			"markOnboardingShown" as keyof typeof InteractiveMode.prototype
		] as (this: Context) => void,
		getOnboardingState: (): OnboardingStartupState =>
			({
				settingsManager: context.settingsManager,
				modelRegistry: {
					refresh: () => {},
					hasConfiguredAuth: () => options.modelReady,
					getProviderAuthStatus: () => ({
						configured: options.modelReady,
						source: options.modelReady ? "runtime" : undefined,
					}),
					authStorage: { get: () => undefined },
				},
				model: options.modelReady ? { id: "m", provider: "anthropic" } : undefined,
			}) as unknown as OnboardingStartupState,
		getCurrentModel: () => (options.modelReady ? { id: "m", provider: "anthropic" } : undefined),
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: options.modelReady, source: "runtime" }),
			authStorage: { get: () => undefined },
		},
	};
	return context;
}

describe("InteractiveMode startup onboarding completion", () => {
	beforeAll(() => initTheme("dark"));

	it("does not mark onboarding shown when the flow ends without a ready model", async () => {
		const context = makeContext({ modelReady: false });
		await prototype.runStartupOnboarding.call(context);
		expect(context.settingsManager.getOnboardingShown()).toBe(false);
	});

	it("marks onboarding shown only after a completed flow", async () => {
		const context = makeContext({ modelReady: true });
		await prototype.runStartupOnboarding.call(context);
		expect(context.settingsManager.getOnboardingShown()).toBe(true);
	});
});
