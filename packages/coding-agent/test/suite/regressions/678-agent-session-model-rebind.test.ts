import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.js";

describe("agent session model rebinding", () => {
	it("rebinds the live and scoped model objects from the refreshed registry", async () => {
		const harness = await createHarness();
		try {
			const { session, faux } = harness;
			const original = session.model;
			expect(original).toBeDefined();
			session.setScopedModels([{ model: original! }]);

			// Simulate a credential change reshaping the catalog (e.g. an OAuth
			// login switching a provider between API rails).
			session.modelRegistry.registerProvider(original!.provider, {
				baseUrl: "https://rebound.example/v1",
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((registeredModel) => ({
					id: registeredModel.id,
					name: registeredModel.name,
					api: registeredModel.api,
					reasoning: registeredModel.reasoning,
					input: registeredModel.input,
					cost: registeredModel.cost,
					contextWindow: registeredModel.contextWindow,
					maxTokens: registeredModel.maxTokens,
					baseUrl: "https://rebound.example/v1",
				})),
			});

			const historyLengthBefore = session.messages.length;
			session.rebindModelsFromRegistry();

			expect(session.model).not.toBe(original);
			expect(session.model?.provider).toBe(original!.provider);
			expect(session.model?.id).toBe(original!.id);
			expect(session.model?.baseUrl).toBe("https://rebound.example/v1");
			expect(session.scopedModels[0]?.model.baseUrl).toBe("https://rebound.example/v1");
			// Rebinding keeps the same logical selection: no session history entries.
			expect(session.messages.length).toBe(historyLengthBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the same model object when the catalog shape is unchanged", async () => {
		const harness = await createHarness();
		try {
			const { session } = harness;
			const original = session.model;
			session.rebindModelsFromRegistry();
			expect(session.model).toBe(original);
		} finally {
			harness.cleanup();
		}
	});
});
