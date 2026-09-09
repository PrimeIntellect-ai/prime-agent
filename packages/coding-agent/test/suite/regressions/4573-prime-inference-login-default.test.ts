import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { findInitialModel, PRIME_INFERENCE_DEFAULT_MODEL_ID } from "../../../src/core/model-resolver.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../../../src/core/prime-inference-auth.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import type { AgentConnectionModel } from "../../../src/modes/agent-connection/types.js";
import type { AuthenticationResult } from "../../../src/modes/interactive/auth-flows.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { createHarness, type Harness } from "../harness.js";

type LoginHarness = {
	prepareForModelSelectionAfterLogin(authResult: AuthenticationResult): Promise<boolean>;
	getCurrentModel(): AgentConnectionModel | undefined;
	getConnectionAvailableModels(): Promise<AgentConnectionModel[]>;
	applySelectedModel(model: AgentConnectionModel): Promise<void>;
	showError(message: string): void;
	uiServices: {
		modelRegistry: {
			find(provider: string, modelId: string): AgentConnectionModel | undefined;
		};
		settingsManager: {
			flush(): Promise<void>;
		};
	};
};

const prepareForModelSelectionAfterLogin = (InteractiveMode.prototype as unknown as LoginHarness)
	.prepareForModelSelectionAfterLogin;

describe("ENG-4573 Prime Inference login default", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("persists GLM 5.3 so the next process starts with a valid model", async () => {
		const harness = await createHarness({
			provider: PRIME_INFERENCE_PROVIDER_ID,
			models: [{ id: PRIME_INFERENCE_DEFAULT_MODEL_ID, name: "GLM 5.3" }],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		const settings = SettingsManager.create(harness.tempDir, agentDir);

		settings.setDefaultModelAndProvider(PRIME_INFERENCE_PROVIDER_ID, PRIME_INFERENCE_DEFAULT_MODEL_ID);
		await settings.flush();

		const restartedSettings = SettingsManager.create(harness.tempDir, agentDir);
		expect(restartedSettings.getDefaultProvider()).toBe(PRIME_INFERENCE_PROVIDER_ID);
		expect(restartedSettings.getDefaultModel()).toBe(PRIME_INFERENCE_DEFAULT_MODEL_ID);

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: restartedSettings.getDefaultProvider(),
			defaultModelId: restartedSettings.getDefaultModel(),
			modelRegistry: harness.session.modelRegistry,
		});

		expect(initial.model?.provider).toBe(PRIME_INFERENCE_PROVIDER_ID);
		expect(initial.model?.id).toBe(PRIME_INFERENCE_DEFAULT_MODEL_ID);
	});

	test("refreshes authenticated models before selecting and persisting GLM 5.3", async () => {
		const fallbackModel: AgentConnectionModel = {
			id: PRIME_INFERENCE_DEFAULT_MODEL_ID,
			name: "GLM 5.3",
			api: "openai-completions",
			provider: PRIME_INFERENCE_PROVIDER_ID,
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 101376,
		};
		const placeholderModel: AgentConnectionModel = {
			...fallbackModel,
			id: "unknown",
			name: "unknown",
			provider: "unknown",
		};
		const order: string[] = [];
		const fakeThis = Object.create(InteractiveMode.prototype) as LoginHarness;
		fakeThis.getCurrentModel = vi.fn(() => placeholderModel);
		fakeThis.getConnectionAvailableModels = vi.fn(async () => {
			order.push("refresh");
			return [fallbackModel];
		});
		fakeThis.applySelectedModel = vi.fn(async () => {
			order.push("select");
		});
		fakeThis.showError = vi.fn();
		fakeThis.uiServices = {
			modelRegistry: {
				find: vi.fn(() => undefined),
			},
			settingsManager: {
				flush: vi.fn(async () => {
					order.push("persist");
				}),
			},
		};

		await expect(
			prepareForModelSelectionAfterLogin.call(fakeThis, {
				status: "success",
				providerId: PRIME_INFERENCE_PROVIDER_ID,
				providerName: "Prime Inference",
				authType: "api_key",
				kind: "provider",
			}),
		).resolves.toBe(true);

		expect(fakeThis.applySelectedModel).toHaveBeenCalledWith(fallbackModel);
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(order).toEqual(["refresh", "select", "persist"]);
	});
});
