import { getApiProvider } from "../../../ai/src/index.js";
import { fauxAssistantMessage, registerFauxProvider } from "../../../ai/src/providers/faux.js";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerEng4600FauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	faux.setResponses(Array.from({ length: 16 }, (_, index) => fauxAssistantMessage(`upgrade response ${index + 1}`)));
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
