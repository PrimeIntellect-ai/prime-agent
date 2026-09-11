import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { resolvePrimeInferencePostLoginModelAction } from "../src/core/prime-inference-model-selection.js";

const glmModel: Model<"openai-completions"> = {
	id: "z-ai/glm-5.3",
	name: "GLM 5.3",
	api: "openai-completions",
	provider: "prime-inference",
	baseUrl: "https://api.pinference.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 101376,
};

const registry = {
	find: (provider: string, modelId: string) =>
		provider === glmModel.provider && modelId === glmModel.id ? glmModel : undefined,
};

describe("Prime Inference post-login model selection", () => {
	test("selects GLM 5.3 as a fallback and opens the model picker", () => {
		const action = resolvePrimeInferencePostLoginModelAction(
			{
				status: "success",
				providerId: "prime-inference",
				kind: "provider",
			},
			undefined,
			registry,
		);

		expect(action).toEqual({ openModelPicker: true, fallbackModel: glmModel });
	});

	test("keeps an existing model while still opening the model picker", () => {
		const currentModel = { ...glmModel, id: "openai/gpt-5.5", name: "GPT-5.5" };
		const action = resolvePrimeInferencePostLoginModelAction(
			{
				status: "success",
				providerId: "prime-inference",
				kind: "provider",
			},
			currentModel,
			registry,
		);

		expect(action).toEqual({ openModelPicker: true, fallbackModel: undefined });
	});

	test("does nothing after another provider login", () => {
		const action = resolvePrimeInferencePostLoginModelAction(
			{
				status: "success",
				providerId: "anthropic",
				kind: "provider",
			},
			undefined,
			registry,
		);

		expect(action).toEqual({ openModelPicker: false });
	});

	test("does nothing when login is cancelled", () => {
		const action = resolvePrimeInferencePostLoginModelAction({ status: "cancelled" }, undefined, registry);

		expect(action).toEqual({ openModelPicker: false });
	});
});
