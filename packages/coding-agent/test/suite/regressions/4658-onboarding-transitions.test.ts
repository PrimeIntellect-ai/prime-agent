import { Container, Input, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import type { ModelRegistry } from "../../../src/core/model-registry.js";
import type { AgentConnectionModel } from "../../../src/modes/agent-connection/types.js";
import type { AuthenticationResult } from "../../../src/modes/interactive/auth-flows.js";
import { ConfigurationMenuComponent } from "../../../src/modes/interactive/components/configuration-menu.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

interface OnboardingSplashHandle {
	showProgress(message: string): void;
	dismiss(): void;
}

interface InteractiveOnboardingHarness {
	runOnboardingFlow(showPrimeCliSplash?: boolean): Promise<void>;
	uiServices: {
		modelRegistry: ModelRegistry;
	};
	getModelCandidates(): Promise<AgentConnectionModel[]>;
	showOnboardingSplash(continueActionLabel?: string): Promise<OnboardingSplashHandle | undefined>;
	createAuthFlows(): {
		runPrimeInferenceLogin(): Promise<AuthenticationResult>;
	};
	prepareForModelSelectionAfterLogin(authResult: AuthenticationResult): Promise<boolean>;
	showConfigurationMenu(tab: "providers" | "models" | "mcp-connections"): Promise<void>;
}

interface ConfigurationHarness {
	showConfigurationMenu(tab: "providers" | "models" | "mcp-connections"): Promise<void>;
	editor: Input;
	editorContainer: Container;
	ui: TUI;
	uiServices: {
		modelRegistry: ModelRegistry;
		settingsManager: Harness["settingsManager"];
	};
	getCachedModelCandidates(): AgentConnectionModel[];
	getScopedModelState(): [];
	getCurrentModel(): AgentConnectionModel;
	getModelSelectorRefreshPromise(): undefined;
	createAuthFlows(): {
		getLoginProviderOptions(): Array<{ id: string; name: string; authType: "api_key" }>;
		loginProvider(): Promise<AuthenticationResult>;
	};
	showError(message: string): void;
	showStatus(message: string): void;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("ENG-4658 onboarding transitions", () => {
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

	test("dismisses the splash before opening first-launch model selection inline", async () => {
		const harness = await createHarness({ provider: "prime-inference", withConfiguredAuth: false });
		harnesses.push(harness);
		const order: string[] = [];
		const configuration = deferred<void>();
		const splash: OnboardingSplashHandle = {
			showProgress: (message) => order.push(`progress:${message}`),
			dismiss: () => order.push("dismiss"),
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as InteractiveOnboardingHarness;
		fakeThis.uiServices = { modelRegistry: harness.session.modelRegistry };
		fakeThis.getModelCandidates = vi.fn(async () => []);
		fakeThis.showOnboardingSplash = vi.fn(async () => splash);
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
		fakeThis.showConfigurationMenu = vi.fn((tab) => {
			order.push(`configuration:${tab}`);
			return configuration.promise;
		});

		const onboarding = fakeThis.runOnboardingFlow(false);
		await vi.waitFor(() => expect(fakeThis.showConfigurationMenu).toHaveBeenCalledWith("models"));

		expect(order.slice(-2)).toEqual(["dismiss", "configuration:models"]);
		configuration.resolve();
		await onboarding;

		expect(fakeThis.showOnboardingSplash).toHaveBeenCalledWith();
		expect(order).toEqual([
			"progress:Signing in to Prime Intellect...",
			"login",
			"progress:Preparing models...",
			"prepare",
			"dismiss",
			"configuration:models",
		]);
	});

	test("keeps the inline picker mounted during authentication and restores the draft after closing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const login = deferred<AuthenticationResult>();
		const model = harness.getModel() as AgentConnectionModel;
		const fakeThis = Object.create(InteractiveMode.prototype) as ConfigurationHarness;
		fakeThis.editor = new Input();
		fakeThis.editor.setValue("draft prompt");
		fakeThis.editorContainer = new Container();
		fakeThis.editorContainer.addChild(fakeThis.editor);
		fakeThis.ui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			setFocus: vi.fn(),
		} as unknown as TUI;
		fakeThis.uiServices = {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		};
		fakeThis.getCachedModelCandidates = () => [model];
		fakeThis.getScopedModelState = () => [];
		fakeThis.getCurrentModel = () => model;
		fakeThis.getModelSelectorRefreshPromise = () => undefined;
		fakeThis.createAuthFlows = () => ({
			getLoginProviderOptions: () => [{ id: model.provider, name: model.provider, authType: "api_key" }],
			loginProvider: () => login.promise,
		});
		fakeThis.showError = vi.fn();
		fakeThis.showStatus = vi.fn();

		const configuration = fakeThis.showConfigurationMenu("providers");
		const menu = fakeThis.editorContainer.children[0] as ConfigurationMenuComponent;
		expect(menu).toBeInstanceOf(ConfigurationMenuComponent);
		menu.handleInput("\r");

		expect(fakeThis.editorContainer.children).toEqual([menu]);
		expect(fakeThis.editor.getValue()).toBe("draft prompt");

		login.resolve({ status: "cancelled" });
		await vi.waitFor(() => expect(fakeThis.ui.setFocus).toHaveBeenCalledTimes(2));
		expect(fakeThis.ui.setFocus).toHaveBeenLastCalledWith(menu);
		expect(fakeThis.editorContainer.children).toEqual([menu]);
		menu.handleInput("\x1b");
		await expect(configuration).resolves.toBeUndefined();
		expect(fakeThis.editorContainer.children).toEqual([fakeThis.editor]);
		expect(fakeThis.ui.setFocus).toHaveBeenLastCalledWith(fakeThis.editor);
		expect(fakeThis.editor.getValue()).toBe("draft prompt");
	});
});
