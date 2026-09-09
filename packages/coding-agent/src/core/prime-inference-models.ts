import { isPrivatePrimeInferenceModelId, type Model, parsePrimeInferenceModelCatalog } from "@earendil-works/pi-ai";
import { buildPrimeInferenceModels, PRIME_INFERENCE_BASE_URL } from "./prime-inference-model-catalog.js";

export { PRIME_INFERENCE_BASE_URL };

const PRIVATE_PRIME_INFERENCE_MODELS: readonly Model<"openai-completions">[] = [
	{
		id: "internal/glm-5.2-fast",
		name: "GLM 5.2 Fast",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: PRIME_INFERENCE_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 131072,
		featured: true,
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
];

export function isPrivatePrimeInferenceModel(model: Pick<Model<string>, "provider" | "id">): boolean {
	return model.provider === "prime-inference" && isPrivatePrimeInferenceModelId(model.id);
}

export function getPrivatePrimeInferenceModels(): Model<"openai-completions">[] {
	return PRIVATE_PRIME_INFERENCE_MODELS.map((model) => ({
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		compat: model.compat ? { ...model.compat } : undefined,
	}));
}

export function parsePrimeInferenceCatalogModels(
	payload: unknown,
	bundledPublicModels: readonly Model<"openai-completions">[],
	authenticated: boolean,
): Model<"openai-completions">[] {
	const templates = authenticated
		? [...bundledPublicModels, ...getPrivatePrimeInferenceModels()]
		: bundledPublicModels;
	const entries = parsePrimeInferenceModelCatalog(payload, { allowEmpty: authenticated });
	// Older private endpoints sometimes advertise a known route by ID alone.
	if (authenticated && payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)) {
		const ids = new Set(entries.map((entry) => entry.id.toLowerCase()));
		const privateTemplates = new Map(
			getPrivatePrimeInferenceModels().map((model) => [model.id.toLowerCase(), model]),
		);
		for (const item of payload.data) {
			if (!item || typeof item !== "object" || typeof item.id !== "string" || ids.has(item.id.toLowerCase()))
				continue;
			const template = privateTemplates.get(item.id.toLowerCase());
			if (template) {
				entries.push({ id: item.id, input: template.cost.input, output: template.cost.output });
				ids.add(item.id.toLowerCase());
			}
		}
	}
	const models = buildPrimeInferenceModels(templates, entries, {
		includePrivate: authenticated,
		...(authenticated ? { minimumModels: 0 } : {}),
	});
	if (!models) throw new Error("Incomplete Prime Inference catalog");
	if (authenticated) {
		const publicModels = buildPrimeInferenceModels(bundledPublicModels, entries);
		if (!publicModels) {
			// A partial authenticated catalog can still revoke private routes; retain a usable public fallback.
			const merged = new Map(bundledPublicModels.map((model) => [model.id, model]));
			for (const model of models) merged.set(model.id, model);
			return [...merged.values()];
		}
	}
	return models;
}
