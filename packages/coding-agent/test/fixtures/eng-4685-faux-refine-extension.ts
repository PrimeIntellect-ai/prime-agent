import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * ENG-4685 faux provider extension for process-backed serialized-refine proof.
 *
 * Queues exactly three responses so the real daemon worker, model, and
 * auto-refine machinery all exercise the real code paths:
 *
 *  1. Parent assistant response for the user prompt.
 *  2. Valid auto-refine review JSON (shouldRefine: true).
 *  3. Valid empty refinement-proposal JSON (edits: []).
 *
 * The auto-refine review and plan both call completeSimple on the same
 * faux provider, so they consume responses 2 and 3 from the same queue.
 */
export default function registerEng4685FauxRefineProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});

	faux.setResponses([
		// 1 — parent response for "Say hello"
		fauxAssistantMessage("Hello from the faux provider."),
		// 2 — auto-refine review JSON (parsed by parseAutoRefineReview)
		fauxAssistantMessage(JSON.stringify({ shouldRefine: true, rationale: "process-proof review" })),
		// 3 — empty refinement proposal JSON (parsed by parseProposal)
		fauxAssistantMessage(
			JSON.stringify({
				summary: "No edits needed",
				rationale: "process-proof empty proposal",
				edits: [],
				expectedOutcome: "No changes",
			}),
		),
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
