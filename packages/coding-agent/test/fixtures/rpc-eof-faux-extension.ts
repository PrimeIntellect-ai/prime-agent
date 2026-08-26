import { getApiProvider } from "../../../ai/src/index.js";
import { fauxAssistantMessage, registerFauxProvider } from "../../../ai/src/providers/faux.js";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerRpcEofFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 250));
			return fauxAssistantMessage("rpc eof response");
		},
	]);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models,
	});
}
