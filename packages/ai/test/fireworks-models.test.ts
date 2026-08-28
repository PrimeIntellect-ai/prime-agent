import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

describe("Fireworks models", () => {
	it("registers a well-formed Anthropic-compatible catalog", () => {
		const models = getModels("fireworks");

		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("fireworks");
			expect(model.baseUrl).toBe("https://api.fireworks.ai/inference");
			expect(model.cost.input).toBeGreaterThanOrEqual(0);
			expect(model.cost.output).toBeGreaterThanOrEqual(0);
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
		}
	});

	it("keeps the coding-agent default model available", () => {
		// Guards defaultModelPerProvider.fireworks in packages/coding-agent.
		expect(getModel("fireworks", "accounts/fireworks/models/kimi-k2p6")).toBeDefined();
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});
});
