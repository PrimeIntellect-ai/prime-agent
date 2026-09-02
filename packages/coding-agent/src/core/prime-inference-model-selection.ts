import type { Api, Model } from "@prime-intellect/prime-agent-ai";
import type { ModelRegistry } from "./model-registry.js";
import { PRIME_INFERENCE_DEFAULT_MODEL_ID } from "./model-resolver.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "./prime-inference-auth.js";

type ProviderLoginResult =
	| { status: "success"; providerId: string; kind?: "provider" | "service" }
	| { status: "cancelled" | "failed" };

export interface PrimeInferencePostLoginModelAction {
	openModelPicker: boolean;
	fallbackModel?: Model<Api>;
}

export function resolvePrimeInferencePostLoginModelAction(
	authResult: ProviderLoginResult,
	currentModel: Model<Api> | undefined,
	modelRegistry: Pick<ModelRegistry, "find">,
): PrimeInferencePostLoginModelAction {
	if (
		authResult.status !== "success" ||
		authResult.kind === "service" ||
		authResult.providerId !== PRIME_INFERENCE_PROVIDER_ID
	) {
		return { openModelPicker: false };
	}

	return {
		openModelPicker: true,
		fallbackModel: currentModel
			? undefined
			: modelRegistry.find(PRIME_INFERENCE_PROVIDER_ID, PRIME_INFERENCE_DEFAULT_MODEL_ID),
	};
}
