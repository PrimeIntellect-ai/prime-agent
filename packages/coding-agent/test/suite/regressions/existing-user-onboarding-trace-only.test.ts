import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import type { ModelRegistry } from "../../../src/core/model-registry.js";
import type { SettingsManager } from "../../../src/core/settings-manager.js";
import type { AgentConnectionModel } from "../../../src/modes/agent-connection/types.js";
import type { AuthenticationResult } from "../../../src/modes/interactive/auth-flows.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

interface OnboardingSplashHandle {
	dismiss(): void;
}

interface ExistingUserOnboardingHarness {
	runOnboardingFlow(): Promise<boolean>;
	uiServices: {
		modelRegistry: ModelRegistry;
		settingsManager: SettingsManager;
	};
	connectionState: { model: AgentConnectionModel } | undefined;
	onboardingFlowAbort: AbortController | undefined;
	showOnboardingSplash(options?: { immediate?: boolean }): Promise<OnboardingSplashHandle | undefined>;
	askOnboardingTraceOptIn(): Promise<void>;
	createAuthFlows(): {
		runPrimeInferenceLogin(): Promise<AuthenticationResult>;
	};
	prepareForModelSelectionAfterLogin(authResult: AuthenticationResult): Promise<boolean>;
	askOnboardingProviders(signal: AbortSignal): Promise<void>;
}

describe("existing user onboarding shows only trace question", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("existing user sees only the trace question, not login or provider picker", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: true });
		harnesses.push(harness);
		const order: string[] = [];
		const splash: OnboardingSplashHandle = {
			dismiss: () => order.push("dismiss"),
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as ExistingUserOnboardingHarness;
		fakeThis.uiServices = {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		};
		fakeThis.connectionState = { model: harness.getModel() as AgentConnectionModel };
		fakeThis.onboardingFlowAbort = undefined;
		fakeThis.showOnboardingSplash = vi.fn(async () => {
			order.push("splash");
			return splash;
		});
		fakeThis.askOnboardingTraceOptIn = vi.fn(async () => {
			order.push("trace");
		});
		fakeThis.createAuthFlows = vi.fn(() => ({
			runPrimeInferenceLogin: vi.fn(async (): Promise<AuthenticationResult> => {
				order.push("login");
				return {
					status: "success",
					providerId: "prime-inference",
					providerName: "Prime Inference",
					authType: "api_key",
					kind: "provider",
				};
			}),
		}));
		fakeThis.prepareForModelSelectionAfterLogin = vi.fn(async () => {
			order.push("prepare");
			return true;
		});
		fakeThis.askOnboardingProviders = vi.fn(async () => {
			order.push("providers");
		});

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		expect(fakeThis.showOnboardingSplash).toHaveBeenCalledWith({ immediate: true });
		expect(fakeThis.createAuthFlows).not.toHaveBeenCalled();
		expect(fakeThis.prepareForModelSelectionAfterLogin).not.toHaveBeenCalled();
		expect(fakeThis.askOnboardingProviders).not.toHaveBeenCalled();
		expect(fakeThis.askOnboardingTraceOptIn).toHaveBeenCalled();
		expect(order).toEqual(["splash", "trace", "dismiss"]);
	});

	test("existing user with traces already enabled completes silently", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: true });
		harnesses.push(harness);
		harness.settingsManager.setAgentTracesEnabled(true);
		const fakeThis = Object.create(InteractiveMode.prototype) as ExistingUserOnboardingHarness;
		fakeThis.uiServices = {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		};
		fakeThis.connectionState = { model: harness.getModel() as AgentConnectionModel };
		fakeThis.onboardingFlowAbort = undefined;
		fakeThis.showOnboardingSplash = vi.fn(async () => ({ dismiss: vi.fn() }));
		fakeThis.askOnboardingTraceOptIn = vi.fn();
		fakeThis.createAuthFlows = vi.fn(() => ({
			runPrimeInferenceLogin: vi.fn(),
		}));

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		expect(fakeThis.showOnboardingSplash).not.toHaveBeenCalled();
		expect(fakeThis.askOnboardingTraceOptIn).not.toHaveBeenCalled();
		expect(fakeThis.createAuthFlows).not.toHaveBeenCalled();
	});

	test("new user without configured auth runs the full flow unchanged", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: false });
		harnesses.push(harness);
		const order: string[] = [];
		const splash: OnboardingSplashHandle = {
			dismiss: () => order.push("dismiss"),
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as ExistingUserOnboardingHarness;
		fakeThis.uiServices = {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		};
		fakeThis.connectionState = undefined;
		fakeThis.onboardingFlowAbort = undefined;
		fakeThis.showOnboardingSplash = vi.fn(async () => {
			order.push("splash");
			return splash;
		});
		fakeThis.askOnboardingTraceOptIn = vi.fn(async () => {
			order.push("trace");
		});
		fakeThis.createAuthFlows = vi.fn(() => ({
			runPrimeInferenceLogin: async (): Promise<AuthenticationResult> => {
				order.push("login");
				return {
					status: "success",
					providerId: "prime-inference",
					providerName: "Prime Inference",
					authType: "api_key",
					kind: "provider",
				};
			},
		}));
		fakeThis.prepareForModelSelectionAfterLogin = vi.fn(async () => {
			order.push("prepare");
			return true;
		});
		fakeThis.askOnboardingProviders = vi.fn(async () => {
			order.push("providers");
		});

		const result = await fakeThis.runOnboardingFlow();

		expect(result).toBe(true);
		// New user: splash waits for Enter (no immediate option)
		expect(fakeThis.showOnboardingSplash).toHaveBeenCalledWith();
		expect(fakeThis.createAuthFlows).toHaveBeenCalled();
		expect(fakeThis.prepareForModelSelectionAfterLogin).toHaveBeenCalled();
		expect(fakeThis.askOnboardingProviders).toHaveBeenCalled();
		expect(fakeThis.askOnboardingTraceOptIn).toHaveBeenCalled();
		expect(order).toEqual(["splash", "login", "prepare", "providers", "trace", "dismiss"]);
	});
});
