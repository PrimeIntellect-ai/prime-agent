import type { Api, Model } from "@earendil-works/pi-ai";

export interface OnboardingSettingsReader {
	getOnboardingShown(): boolean;
}

export interface OnboardingModelRegistryReader {
	refresh(): void;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface OnboardingStartupState {
	settingsManager: OnboardingSettingsReader;
	modelRegistry: OnboardingModelRegistryReader;
	model: Model<Api> | undefined;
}

export function isOnboardingModelReady(state: OnboardingStartupState): boolean {
	return state.model !== undefined && state.modelRegistry.hasConfiguredAuth(state.model);
}

/**
 * First launch is defined by the settings flag alone. Credentials found on disk
 * (a Prime CLI token, an API key in the environment) no longer skip the flow:
 * they only make the sign-in step instant.
 */
export function shouldRunOnboarding(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown()) {
		return false;
	}
	state.modelRegistry.refresh();
	return true;
}
