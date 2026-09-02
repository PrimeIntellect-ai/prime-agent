import type { Api, Model } from "@prime-intellect/prime-agent-ai";
import type { AuthStatus } from "../../core/auth-storage.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../../core/prime-inference-auth.js";

export interface OnboardingSettingsReader {
	getOnboardingShown(): boolean;
}

export interface OnboardingModelRegistryReader {
	refresh(): void;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): AuthStatus;
}

export interface OnboardingStartupState {
	settingsManager: OnboardingSettingsReader;
	modelRegistry: OnboardingModelRegistryReader;
	model: Model<Api> | undefined;
}

export function shouldRunPrimeCliOnboardingSplash(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown()) {
		return false;
	}
	if (!state.model || state.model.provider !== PRIME_INFERENCE_PROVIDER_ID) {
		return false;
	}
	const authStatus = state.modelRegistry.getProviderAuthStatus(PRIME_INFERENCE_PROVIDER_ID);
	return authStatus.source === "prime_cli";
}

export function isOnboardingModelReady(state: OnboardingStartupState): boolean {
	return state.model !== undefined && state.modelRegistry.hasConfiguredAuth(state.model);
}

export function shouldRunOnboarding(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown()) {
		return false;
	}
	state.modelRegistry.refresh();
	if (shouldRunPrimeCliOnboardingSplash(state)) {
		return true;
	}
	return !isOnboardingModelReady(state);
}
